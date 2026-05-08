const { Campaign } = require("../models/Campaign");
const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");
const { Template } = require("../models/Template");
const { Message } = require("../models/Message");
const { getCampaignQueue } = require("../services/campaignQueue");
const { assertNormalizedPhone } = require("../services/contactService");
const {
  ensureBalance,
  getOrCreateWallet,
  messageCostForTemplateCategory,
  walletChargesEnabled,
  roundCurrency,
} = require("../services/walletService");
const { Conversation } = require("../models/Conversation");
const { CUSTOMER_SERVICE_WINDOW_MS } = require("../services/pricingService");
const { sendTemplateMessageForUser } = require("../services/outboundMessageService");
const { debit, credit } = require("../services/walletService");

function normalizeRecipients(recipients) {
  const out = [];
  const seen = new Set();
  for (const r of recipients || []) {
    const raw = typeof r === "string" ? { to: r } : (r || {});
    const to = assertNormalizedPhone(raw.to);
    if (!to) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    out.push({
      to,
      variables: Array.isArray(raw.variables) ? raw.variables : undefined,
      headerVariables: Array.isArray(raw.headerVariables) ? raw.headerVariables : undefined,
      otpCode: raw.otpCode ? String(raw.otpCode) : undefined,
      buttonValues: Array.isArray(raw.buttonValues) ? raw.buttonValues : undefined,
      buttonTtlMinutes: Array.isArray(raw.buttonTtlMinutes) ? raw.buttonTtlMinutes : undefined,
      flowTokens: Array.isArray(raw.flowTokens) ? raw.flowTokens : undefined,
      flowActionData: Array.isArray(raw.flowActionData) ? raw.flowActionData : undefined,
    });
  }
  return out;
}

async function computeEstimate({ workspaceId, template, recipients }) {
  const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
  const phones = recipients.map((r) => r.to);
  const openRows = await Conversation.find({
    workspaceId,
    phone: { $in: phones },
    lastInboundAt: { $gte: since },
  })
    .select("phone")
    .lean();

  const openSet = new Set(openRows.map((r) => String(r.phone || "")));
  const billableCount = recipients.filter((r) => !openSet.has(String(r.to))).length;
  const freeCount = recipients.length - billableCount;
  const estimatedCredits = roundCurrency(messageCostForTemplateCategory(template.category, billableCount));
  return { totalRecipients: recipients.length, billableRecipients: billableCount, freeRecipients: freeCount, estimatedCredits, openSet };
}

async function resolveWorkspaceIdFromApiKeyUser(req) {
  const workspaceIdHeader = req.headers["x-workspace-id"];
  if (workspaceIdHeader) {
    return String(workspaceIdHeader);
  }

  const ws = await Workspace.findOne({ ownerId: req.user.id, isActive: true })
    .sort({ createdAt: 1 })
    .select("_id");
  if (!ws) throw new HttpError(404, "Workspace not found for API key owner");
  return String(ws._id);
}

async function sendApiCampaignByName(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceIdFromApiKeyUser(req);

    const campaignName = String(req.body?.campaignName || "").trim();
    if (!campaignName) throw new HttpError(400, "campaignName is required");

    const definition = await Campaign.findOne({
      workspaceId,
      type: "api",
      name: campaignName,
    }).select("_id name templateId type");

    if (!definition) {
      throw new HttpError(404, "API campaign not found. Create an API campaign with this name first.");
    }

    const recipients = normalizeRecipients(req.body?.recipients);
    if (!recipients.length) throw new HttpError(400, "At least one recipient required");

    const template = await Template.findOne({ _id: definition.templateId, workspaceId }).select("_id status category name language components");
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

    const estimate = await computeEstimate({ workspaceId, template, recipients });
    if (walletChargesEnabled() && estimate.estimatedCredits > 0) {
      try {
        await ensureBalance(workspaceId, estimate.estimatedCredits);
      } catch (err) {
        if (err instanceof HttpError && err.statusCode === 402) {
          const wallet = await getOrCreateWallet(workspaceId);
          throw new HttpError(402, "Insufficient wallet balance for this campaign", {
            balance: wallet.balance,
            required: estimate.estimatedCredits,
            billableRecipients: estimate.billableRecipients,
            freeRecipients: estimate.freeRecipients,
            totalRecipients: recipients.length,
          });
        }
        throw err;
      }
    }

    // Reuse the existing API campaign definition (do NOT create a second campaign).
    await Campaign.updateOne(
      { _id: definition._id, workspaceId },
      {
        $set: { status: "queued" },
        $inc: {
          "totals.total": recipients.length,
          "totals.queued": recipients.length,
        },
        $unset: { lastError: 1 },
      }
    );

    const campaignQueue = getCampaignQueue();
    const delayMs = req.body?.scheduledAt ? Math.max(new Date(req.body.scheduledAt).getTime() - Date.now(), 0) : 0;

    let queuedToRedis = true;
    try {
      await Promise.all(
        recipients.map((recipient) =>
          campaignQueue.add(
            "send-message",
            {
              workspaceId,
              campaignId: String(definition._id),
              templateId: String(template._id),
              to: recipient.to,
              variables: recipient.variables,
              headerVariables: recipient.headerVariables,
              otpCode: recipient.otpCode,
              buttonValues: recipient.buttonValues,
              buttonTtlMinutes: recipient.buttonTtlMinutes,
              flowTokens: recipient.flowTokens,
              flowActionData: recipient.flowActionData,
            },
            { delay: delayMs, removeOnComplete: 5000, removeOnFail: 5000 }
          )
        )
      );
    } catch (queueErr) {
      queuedToRedis = false;
      await Campaign.updateOne(
        { _id: definition._id, workspaceId },
        { $set: { lastError: { message: queueErr?.message || "Failed to enqueue campaign jobs" } } }
      );
    }

    // Inline fallback if worker isn't running (same behavior as UI campaigns).
    if (delayMs === 0) {
      let hasWorkers = false;
      try {
        const workers = await campaignQueue.getWorkers();
        hasWorkers = Array.isArray(workers) && workers.length > 0;
      } catch {
        hasWorkers = false;
      }

      if (!queuedToRedis || !hasWorkers) {
        let sentCount = 0;
        let failedCount = 0;
        let lastFailure = null;

        await Campaign.updateOne({ _id: definition._id, workspaceId }, { $set: { status: "running" } });

        for (const recipient of recipients) {
          const chargeAmount = estimate.openSet.has(String(recipient.to)) ? 0 : messageCostForTemplateCategory(template.category, 1);
          try {
            if (chargeAmount > 0) {
              await debit(workspaceId, chargeAmount, "Message send (campaign)", {
                campaignId: String(definition._id),
                templateId: String(template._id),
                to: recipient.to,
              });
            }
            await sendTemplateMessageForUser({
              userId: workspaceId,
              campaignId: String(definition._id),
              template,
              to: recipient.to,
              variables: recipient.variables,
              headerVariables: recipient.headerVariables,
              otpCode: recipient.otpCode,
              buttonValues: recipient.buttonValues,
              buttonTtlMinutes: recipient.buttonTtlMinutes,
              flowTokens: recipient.flowTokens,
              flowActionData: recipient.flowActionData,
            });
            sentCount += 1;
            await Campaign.updateOne({ _id: definition._id, workspaceId }, { $inc: { "totals.queued": -1, "totals.sent": 1 } });
          } catch (err) {
            failedCount += 1;
            lastFailure = err;
            try {
              await Message.create({
                workspaceId,
                campaignId: String(definition._id),
                templateId: template._id,
                phone: recipient.to,
                direction: "outbound",
                status: "failed",
                statusTimestamps: { failedAt: new Date() },
                text: "",
                payload: { to: recipient.to, template: { id: String(template._id) }, runtime: { variables: recipient.variables || [] } },
                error: err?.response?.data || err?.message || err,
              });
            } catch {}
            if (err?.response && chargeAmount > 0) {
              try {
                await credit(workspaceId, chargeAmount, "Message refund (campaign failed)", "internal", "", {
                  campaignId: String(definition._id),
                  templateId: String(template._id),
                  to: recipient.to,
                });
              } catch {}
            }
            await Campaign.updateOne({ _id: definition._id, workspaceId }, { $inc: { "totals.queued": -1, "totals.failed": 1 } });
          }
        }

        const done = await Campaign.findOne({ _id: definition._id, workspaceId }).select("totals");
        const queued = Number(done?.totals?.queued || 0);
        const nextStatus = queued === 0 ? (failedCount > 0 && sentCount === 0 ? "failed" : "completed") : "running";
        await Campaign.updateOne(
          { _id: definition._id, workspaceId },
          { $set: { status: nextStatus, ...(lastFailure ? { lastError: { message: lastFailure?.message || "Failed" } } : {}) } }
        );
      }
    }

    const refreshed = await Campaign.findOne({ _id: definition._id, workspaceId });
    return res.status(201).json({ success: true, campaign: refreshed, estimate });
  } catch (err) {
    return next(err);
  }
}

module.exports = { sendApiCampaignByName };
