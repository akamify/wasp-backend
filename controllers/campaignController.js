const { Campaign } = require("../models/Campaign");
const { Template } = require("../models/Template");
const { Message } = require("../models/Message");
const { Contact } = require("../models/Contact");
const { Transaction } = require("../models/Transaction");
const { HttpError } = require("../utils/httpError");
const { assertNormalizedPhone } = require("../services/contactService");
const { getCampaignQueue } = require("../services/campaignQueue");
const { sendTemplateMessageForUser } = require("../services/outboundMessageService");
const {
  debit,
  credit,
  ensureBalance,
  getOrCreateWallet,
  messageCostForTemplateCategory,
  walletChargesEnabled,
  roundCurrency,
} = require("../services/walletService");
const { CUSTOMER_SERVICE_WINDOW_MS } = require("../services/pricingService");
const mongoose = require("mongoose");
const { Conversation } = require("../models/Conversation");

function normalizeRecipientsForCampaign(recipients) {
  const normalizedRecipients = [];
  const seen = new Set();

  for (const r of recipients || []) {
    const raw = typeof r === "string" ? { to: r } : (r || {});
    const to = assertNormalizedPhone(raw.to);
    if (!to) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    normalizedRecipients.push({
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
  return normalizedRecipients;
}

async function computeCampaignCreditEstimate({ workspaceId, template, recipients }) {
  const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
  const recipientPhones = recipients.map((r) => r.to);
  const openWindowRows = await Conversation.find({
    workspaceId,
    phone: { $in: recipientPhones },
    lastInboundAt: { $gte: since },
  })
    .select("phone")
    .lean();
  const openWindowSet = new Set(openWindowRows.map((row) => String(row.phone || "")));
  const billableCount = recipients.filter((r) => !openWindowSet.has(String(r.to))).length;
  const freeCount = recipients.length - billableCount;
  const estimatedCredits = roundCurrency(messageCostForTemplateCategory(template.category, billableCount));

  return {
    totalRecipients: recipients.length,
    billableRecipients: billableCount,
    freeRecipients: freeCount,
    estimatedCredits,
  };
}

async function listCampaigns(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const items = await Campaign.find({ workspaceId: req.workspace.id })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ success: true, campaigns: items });
}

async function getCampaign(req, res) {
  const item = await Campaign.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!item) throw new HttpError(404, "Campaign not found");
  res.json({ success: true, campaign: item });
}

async function getCampaignMetrics(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const match = {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
  };

  const countsAgg = await Message.aggregate([
    { $match: match },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(countsAgg.map((row) => [String(row._id), Number(row.count || 0)]));

  // Best-effort replied detection:
  // Any inbound message from the same phone after campaign createdAt counts as a reply.
  const phones = await Message.distinct("phone", match);
  const repliedPhones = phones.length
    ? await Message.distinct("phone", {
      workspaceId: campaign.workspaceId,
      direction: "inbound",
      phone: { $in: phones },
      createdAt: { $gte: campaign.createdAt },
    })
    : [];
  const repliesCount = repliedPhones.length;

  res.json({
    success: true,
    campaignId: String(campaign._id),
    audienceTotal: campaign.totals?.total || phones.length || 0,
    counts: {
      queued: counts.queued || 0,
      accepted: counts.accepted || 0,
      sent: counts.sent || 0,
      delivered: counts.delivered || 0,
      read: counts.read || 0,
      failed: (counts.failed || 0) + (counts.timeout_unknown || 0),
      replied: repliesCount || 0,
    },
    updatedAt: new Date().toISOString(),
  });
}

function statusFilterForTab(tab) {
  const t = String(tab || "").toLowerCase();
  if (t === "sent") return { status: { $in: ["sent"] } };
  if (t === "delivered") return { status: { $in: ["delivered"] } };
  if (t === "read") return { status: { $in: ["read"] } };
  if (t === "failed") return { status: { $in: ["failed", "timeout_unknown"] } };
  if (t === "accepted") return { status: { $in: ["accepted"] } };
  if (t === "queued") return { status: { $in: ["queued"] } };
  return {};
}

async function listCampaignMessages(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const tab = String(req.query.tab || "overview");
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
  const skip = (page - 1) * limit;

  const filter = {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
    ...statusFilterForTab(tab),
  };

  const [total, items] = await Promise.all([
    Message.countDocuments(filter),
    Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("phone status createdAt whatsappMessageId error statusTimestamps"),
  ]);

  const phones = items.map((m) => m.phone).filter(Boolean);
  const contacts = phones.length
    ? await Contact.find({ workspaceId: campaign.workspaceId, phone: { $in: phones } }).select("phone name")
    : [];
  const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));

  res.json({
    success: true,
    tab,
    page,
    limit,
    total,
    items: items.map((m) => ({
      id: String(m._id),
      phone: m.phone,
      name: contactMap.get(String(m.phone)) || "",
      status: m.status,
      createdAt: m.createdAt,
      whatsappMessageId: m.whatsappMessageId || null,
      error: m.error || null,
      statusTimestamps: m.statusTimestamps || null,
    })),
  });
}

async function listCampaignReplies(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
  const skip = (page - 1) * limit;

  const phones = await Message.distinct("phone", {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
  });
  if (!phones.length) {
    return res.json({ success: true, page, limit, total: 0, items: [] });
  }

  const pipeline = [
    {
      $match: {
        workspaceId: campaign.workspaceId,
        direction: "inbound",
        phone: { $in: phones },
        createdAt: { $gte: campaign.createdAt },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$phone",
        phone: { $first: "$phone" },
        text: { $first: "$text" },
        createdAt: { $first: "$createdAt" },
      },
    },
  ];

  const [grouped, totalAgg] = await Promise.all([
    Message.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    Message.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = Number(totalAgg?.[0]?.total || 0);
  const replyPhones = grouped.map((r) => String(r.phone || "")).filter(Boolean);
  const contacts = replyPhones.length
    ? await Contact.find({ workspaceId: campaign.workspaceId, phone: { $in: replyPhones } }).select("phone name")
    : [];
  const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));

  return res.json({
    success: true,
    page,
    limit,
    total,
    items: grouped.map((r) => ({
      phone: String(r.phone || ""),
      name: contactMap.get(String(r.phone)) || "",
      text: String(r.text || ""),
      createdAt: r.createdAt,
    })),
  });
}

async function getCampaignCreditUsage(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id }).select("_id workspaceId");
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const rows = await Transaction.aggregate([
    {
      $match: {
        workspaceId: campaign.workspaceId,
        "meta.campaignId": String(campaign._id),
      },
    },
    { $group: { _id: "$type", amount: { $sum: "$amount" } } },
  ]);

  const debits = Number(rows.find((r) => r._id === "debit")?.amount || 0);
  const credits = Number(rows.find((r) => r._id === "credit")?.amount || 0);

  res.json({
    success: true,
    campaignId: String(campaign._id),
    currency: "INR",
    debits,
    credits,
    net: Math.max(debits - credits, 0),
  });
}

async function updateCampaignStatus(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const action = String(req.body?.action || "").toLowerCase();

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const currentStatus = String(campaign.status || "").toLowerCase();
  const isStopped = currentStatus === "canceled" || currentStatus === "cancelled";
  const isFailed = currentStatus === "failed";
  const isPaused = currentStatus === "paused";
  const isLive = currentStatus === "queued" || currentStatus === "running";

  const allowedActions = isLive
    ? new Set(["pause", "stop"])
    : isPaused
      ? new Set(["resume", "stop"])
      : new Set([]);

  if (isStopped || isFailed || !allowedActions.has(action)) {
    throw new HttpError(400, "Action not allowed for current campaign status");
  }

  const nextStatus =
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "queued"
        : action === "stop"
          ? "canceled"
          : null;
  if (!nextStatus) throw new HttpError(400, "Invalid action");

  if (action === "pause" || action === "resume" || action === "stop") {
    try {
      const campaignQueue = getCampaignQueue();
      const campaignId = String(campaign._id);

      if (action === "pause") {
        const jobs = await campaignQueue.getJobs(["waiting", "prioritized"], 0, 5000);
        await Promise.all(
          jobs
            .filter((job) => String(job?.data?.campaignId || "") === campaignId)
            .map((job) => job.moveToDelayed(Date.now() + 365 * 24 * 60 * 60 * 1000))
        );
      }

      if (action === "resume") {
        const jobs = await campaignQueue.getJobs(["delayed"], 0, 5000);
        await Promise.all(
          jobs
            .filter((job) => String(job?.data?.campaignId || "") === campaignId)
            .map((job) => job.promote())
        );
      }

      if (action === "stop") {
        const jobs = await campaignQueue.getJobs(
          ["waiting", "delayed", "active", "prioritized", "paused"],
          0,
          5000
        );
        let removed = 0;
        await Promise.all(
          jobs
            .filter((job) => String(job?.data?.campaignId || "") === campaignId)
            .map(async (job) => {
              try {
                await job.remove();
                removed += 1;
              } catch { }
            })
        );

        if (campaign.totals?.queued && removed > 0) {
          campaign.totals.queued = Math.max(Number(campaign.totals.queued || 0) - removed, 0);
        }
      }
    } catch { }
  }

  campaign.status = nextStatus;
  await campaign.save();
  res.json({ success: true, campaign });
}

async function estimateCampaign(req, res) {
  const { templateId, recipients } = req.body;
  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

  const normalizedRecipients = normalizeRecipientsForCampaign(recipients);
  if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");

  const estimate = await computeCampaignCreditEstimate({
    workspaceId: req.workspace.id,
    template,
    recipients: normalizedRecipients,
  });

  const wallet = await getOrCreateWallet(req.workspace.id);
  const walletBalance = roundCurrency(wallet.balance || 0);
  const estimatedCredits = roundCurrency(estimate.estimatedCredits || 0);
  const insufficient = walletChargesEnabled() && estimatedCredits > walletBalance;

  return res.json({
    success: true,
    estimate: {
      ...estimate,
      estimatedCredits,
      walletBalance,
      currency: wallet.currency || "INR",
      insufficientBalance: insufficient,
    },
  });
}

async function createCampaign(req, res) {
  const { name, templateId, recipients, scheduledAt, type } = req.body;

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

  const normalizedRecipients = normalizeRecipientsForCampaign(recipients);

  if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");

  const estimate = await computeCampaignCreditEstimate({
    workspaceId: req.workspace.id,
    template,
    recipients: normalizedRecipients,
  });
  const { billableRecipients: billableCount, freeRecipients: freeCount, estimatedCredits } = estimate;
  const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
  const recipientPhones = normalizedRecipients.map((r) => r.to);

  if (walletChargesEnabled() && estimatedCredits > 0) {
    try {
      await ensureBalance(req.workspace.id, estimatedCredits);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 402) {
        const wallet = await getOrCreateWallet(req.workspace.id);
        throw new HttpError(402, "Insufficient wallet balance for this campaign", {
          balance: wallet.balance,
          required: estimatedCredits,
          billableRecipients: billableCount,
          freeRecipients: freeCount,
          totalRecipients: normalizedRecipients.length,
        });
      }
      throw err;
    }
  }

  const campaign = await Campaign.create({
    workspaceId: req.workspace.id,
    name,
    templateId: template._id,
    status: "queued",
    type: type || "broadcast",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
    totals: {
      total: normalizedRecipients.length,
      queued: normalizedRecipients.length,
      sent: 0,
      failed: 0,
    },
  });

  const delayMs = campaign.scheduledAt ? Math.max(campaign.scheduledAt.getTime() - Date.now(), 0) : 0;

  const campaignQueue = getCampaignQueue();

  let queuedToRedis = true;
  try {
    await Promise.all(
      normalizedRecipients.map((recipient) =>
        campaignQueue.add(
          "send-message",
          {
            workspaceId: req.workspace.id,
            campaignId: String(campaign._id),
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
          {
            delay: delayMs,
            removeOnComplete: 5000,
            removeOnFail: 5000,
          }
        )
      )
    );
  } catch (queueErr) {
    queuedToRedis = false;
    campaign.lastError = { message: queueErr?.message || "Failed to enqueue campaign jobs" };
    await campaign.save();
  }

  // If worker is not active (or queue add failed), process immediate campaigns inline.
  // This prevents campaigns from getting stuck in "queued" when worker process is not running.
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
      const openNowRows = await Conversation.find({
        workspaceId: req.workspace.id,
        phone: { $in: recipientPhones },
        lastInboundAt: { $gte: since },
      })
        .select("phone")
        .lean();
      const openNowSet = new Set(openNowRows.map((row) => String(row.phone || "")));

      campaign.status = "running";
      await campaign.save();

      for (const recipient of normalizedRecipients) {
        try {
          const chargeAmount = openNowSet.has(String(recipient.to))
            ? 0
            : messageCostForTemplateCategory(template.category, 1);
          if (chargeAmount > 0) {
            await debit(req.workspace.id, chargeAmount, "Message send (campaign)", {
              campaignId: String(campaign._id),
              templateId: String(template._id),
              to: recipient.to,
            });
          }
          await sendTemplateMessageForUser({
            userId: req.workspace.id,
            campaignId: String(campaign._id),
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
        } catch (err) {
          failedCount += 1;
          lastFailure = err?.response?.data?.error?.error_data?.details
            || err?.response?.data?.error?.message
            || err?.response?.data?.message
            || err?.message
            || "Campaign send failed";
          try {
            const now = new Date();
            await Message.create({
              workspaceId: req.workspace.id,
              campaignId: campaign._id,
              templateId: template._id,
              phone: recipient.to,
              direction: "outbound",
              status: "failed",
              statusTimestamps: { failedAt: now },
              text: "",
              payload: {
                to: recipient.to,
                template: { id: String(template._id), name: template.name, language: template.language },
                runtime: {
                  variables: recipient.variables || [],
                  headerVariables: recipient.headerVariables || [],
                  otpCode: recipient.otpCode || "",
                  buttonValues: recipient.buttonValues || [],
                  buttonTtlMinutes: recipient.buttonTtlMinutes || [],
                  flowTokens: recipient.flowTokens || [],
                  flowActionData: recipient.flowActionData || [],
                },
              },
              error: err?.response?.data || err?.message || err || { message: String(lastFailure) },
            });
          } catch { }
          try {
            const chargeAmount = openNowSet.has(String(recipient.to))
              ? 0
              : messageCostForTemplateCategory(template.category, 1);
            if (err?.response) {
              if (chargeAmount > 0) await credit(req.workspace.id, chargeAmount, "Message refund (campaign failed)", "internal", "", {
                campaignId: String(campaign._id),
                templateId: String(template._id),
                to: recipient.to,
              });
            }
          } catch { }
        }
      }

      campaign.totals.queued = 0;
      campaign.totals.sent = sentCount;
      campaign.totals.failed = failedCount;
      campaign.status = failedCount > 0 ? (sentCount > 0 ? "completed" : "failed") : "completed";
      if (failedCount > 0 && lastFailure) {
        campaign.lastError = { message: String(lastFailure) };
      }
      await campaign.save();
    }
  }

  res.status(201).json({
    success: true,
    campaign,
    creditEstimate: estimate,
  });
}

async function retryFailedCampaign(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");

  const baseCampaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!baseCampaign) throw new HttpError(404, "Campaign not found");

  const template = await Template.findOne({ _id: baseCampaign.templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

  // NOTE: Aggregations do not cast string -> ObjectId. `req.workspace.id` is a string.
  const workspaceObjectId = new mongoose.Types.ObjectId(req.workspace.id);

  const failedRows = await Message.aggregate([
    {
      $match: {
        workspaceId: workspaceObjectId,
        campaignId: baseCampaign._id,
        direction: "outbound",
        status: { $in: ["failed", "timeout_unknown"] },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$phone",
        phone: { $first: "$phone" },
        runtime: { $first: "$payload.runtime" },
      },
    },
  ]);

  const normalizedRecipients = normalizeRecipientsForCampaign(
    failedRows.map((row) => ({
      to: String(row.phone || ""),
      variables: Array.isArray(row.runtime?.variables) ? row.runtime.variables : [],
      headerVariables: Array.isArray(row.runtime?.headerVariables) ? row.runtime.headerVariables : [],
      otpCode: row.runtime?.otpCode ? String(row.runtime.otpCode) : "",
      buttonValues: Array.isArray(row.runtime?.buttonValues) ? row.runtime.buttonValues : [],
      buttonTtlMinutes: Array.isArray(row.runtime?.buttonTtlMinutes) ? row.runtime.buttonTtlMinutes : [],
      flowTokens: Array.isArray(row.runtime?.flowTokens) ? row.runtime.flowTokens : [],
      flowActionData: Array.isArray(row.runtime?.flowActionData) ? row.runtime.flowActionData : [],
    }))
  );

  if (!normalizedRecipients.length) {
    throw new HttpError(400, "No failed recipients found for retry");
  }

  const estimate = await computeCampaignCreditEstimate({
    workspaceId: req.workspace.id,
    template,
    recipients: normalizedRecipients,
  });
  const { billableRecipients: billableCount, freeRecipients: freeCount, estimatedCredits } = estimate;
  if (walletChargesEnabled() && estimatedCredits > 0) {
    try {
      await ensureBalance(req.workspace.id, estimatedCredits);
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 402) {
        const wallet = await getOrCreateWallet(req.workspace.id);
        throw new HttpError(402, "Insufficient wallet balance for retry campaign", {
          balance: wallet.balance,
          required: estimatedCredits,
          billableRecipients: billableCount,
          freeRecipients: freeCount,
          totalRecipients: normalizedRecipients.length,
        });
      }
      throw err;
    }
  }

  const retryCampaign = await Campaign.create({
    workspaceId: req.workspace.id,
    name: `Retry - ${baseCampaign.name}`.slice(0, 140),
    templateId: template._id,
    status: "queued",
    type: "broadcast",
    totals: {
      total: normalizedRecipients.length,
      queued: normalizedRecipients.length,
      sent: 0,
      failed: 0,
    },
  });

  const campaignQueue = getCampaignQueue();
  await Promise.all(
    normalizedRecipients.map((recipient) =>
      campaignQueue.add(
        "send-message",
        {
          workspaceId: req.workspace.id,
          campaignId: String(retryCampaign._id),
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
        {
          removeOnComplete: 5000,
          removeOnFail: 5000,
        }
      )
    )
  );

  return res.status(201).json({
    success: true,
    campaign: retryCampaign,
    creditEstimate: estimate,
  });
}

async function listFailedRecipients(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id }).select("_id workspaceId");
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const phones = await Message.distinct("phone", {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
    status: { $in: ["failed", "timeout_unknown"] },
  });

  const normalized = (phones || [])
    .map((p) => String(p || "").replace(/\D/g, ""))
    .filter((p) => p.length >= 8);

  return res.json({ success: true, campaignId: String(campaign._id), phones: normalized });
}

async function deleteCampaign(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const force = String(req.query.force || "").toLowerCase() === "true";

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const runningStatuses = new Set(["queued", "running", "paused"]);
  if (!force && runningStatuses.has(String(campaign.status || "").toLowerCase())) {
    throw new HttpError(409, "Campaign is active. Stop it first or pass force=true to delete.");
  }

  try {
    const campaignQueue = getCampaignQueue();
    const jobs = await campaignQueue.getJobs(["waiting", "delayed", "active", "prioritized", "paused"], 0, 5000);
    await Promise.all(
      jobs
        .filter((job) => String(job?.data?.campaignId || "") === String(campaign._id))
        .map(async (job) => {
          try {
            await job.remove();
          } catch { }
        })
    );
  } catch { }

  const [msgDelete, campDelete] = await Promise.all([
    Message.deleteMany({ workspaceId: req.workspace.id, campaignId: campaign._id }),
    Campaign.deleteOne({ _id: campaign._id, workspaceId: req.workspace.id }),
  ]);

  res.json({
    success: true,
    deleted: {
      campaignId: String(campaign._id),
      campaigns: Number(campDelete?.deletedCount || 0),
      messages: Number(msgDelete?.deletedCount || 0),
    },
  });
}

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaign,
  getCampaignMetrics,
  listCampaignMessages,
  listCampaignReplies,
  getCampaignCreditUsage,
  updateCampaignStatus,
  estimateCampaign,
  retryFailedCampaign,
  listFailedRecipients,
  deleteCampaign,
};
