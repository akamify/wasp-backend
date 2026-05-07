const { Template } = require("../models/Template");
const { Message } = require("../models/Message");
const { HttpError } = require("../utils/httpError");
const { sendTemplateMessageForUser, sendTextMessageForUser } = require("../services/outboundMessageService");
const { getCredentialsForUser } = require("../services/credentialsService");
const { assertNormalizedPhone, normalizePhone } = require("../services/contactService");
const { chargeForMessaging, refundMessagingCharge, messageCostForTemplateCategory } = require("../services/walletService");
const { isCustomerServiceWindowOpen } = require("../services/pricingService");
const { renderTemplatePreviewParts } = require("../utils/templateStructure");

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.name === "MongoServerError";
}

function providerErrorFrom(err) {
  const metaDetails =
    err?.metaDebug?.meta?.error_data?.details ||
    err?.metaDebug?.raw?.error?.error_data?.details ||
    err?.response?.data?.error?.error_data?.details ||
    err?.response?.data?.error?.error_user_title ||
    null;
  return (
    metaDetails ||
    err?.metaDebug?.meta?.error_user_msg ||
    err?.metaDebug?.meta?.message ||
    err?.response?.data?.error?.error_user_msg ||
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    "Unknown error"
  );
}

function buildDetails(err) {
  return {
    providerError: providerErrorFrom(err),
    metaDebug: err?.metaDebug || null,
    status: err?.response?.status || err?.status || err?.statusCode || null,
    code: err?.response?.data?.error?.code || err?.code || null,
    error_subcode: err?.response?.data?.error?.error_subcode || null,
    fbtrace_id: err?.response?.data?.error?.fbtrace_id || null,
    duplicateKey: isDuplicateKeyError(err),
    keyValue: err?.keyValue || null,
  };
}

async function safeLogFailedOutboundMessage({ userId, templateId, phone, err }) {
  try {
    await Message.create({
      workspaceId: userId,
      templateId,
      phone,
      direction: "outbound",
      status: "failed",
      statusTimestamps: { failedAt: new Date() },
      error: buildDetails(err),
    });
  } catch (logErr) {
    console.error("Failed to save failed outbound message log:", logErr);
  }
}

async function sendTemplate(req, res) {
  const {
    templateId,
    to,
    variables,
    headerVariables,
    otpCode,
    buttonValues,
    buttonTtlMinutes,
    flowTokens,
    flowActionData,
    languageCode,
  } = req.body;
  const normalizedPhone = assertNormalizedPhone(to);

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") {
    throw new HttpError(400, "Template must be approved before sending");
  }

  const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: normalizedPhone });
  const chargeAmount = windowOpen ? 0 : messageCostForTemplateCategory(template.category, 1);
  try {
    await chargeForMessaging(req.workspace.id, chargeAmount, "Message send", {
      kind: "single",
      templateId: String(template._id),
      to: normalizedPhone,
      pricing: { customerServiceWindowOpen: windowOpen },
    });
    await getCredentialsForUser(req.workspace.id);

    const result = await sendTemplateMessageForUser({
      userId: req.workspace.id,
      template,
      to: normalizedPhone,
      languageCode,
      variables,
      headerVariables,
      otpCode,
      buttonValues,
      buttonTtlMinutes,
      flowTokens,
      flowActionData,
    });

    res.json({
      success: true,
      message: result.message,
      meta: result.apiResponse,
    });
  } catch (err) {
    if (!err?.statusCode && err?.response) {
      // If provider send failed, refund the wallet debit.
      try {
        await refundMessagingCharge(req.workspace.id, chargeAmount, { templateId: templateId, to: normalizedPhone });
      } catch {}
    }
    if (err.statusCode) {
      throw err;
    }

    await safeLogFailedOutboundMessage({
      userId: req.workspace.id,
      templateId: template._id,
      phone: normalizedPhone,
      err,
    });

    throw new HttpError(
      err?.response?.status || 502,
      "Failed to send template message",
      buildDetails(err)
    );
  }
}

async function bulkSend(req, res) {
  const { templateId, recipients, languageCode } = req.body;

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") {
    throw new HttpError(400, "Template must be approved before sending");
  }

  await getCredentialsForUser(req.workspace.id);

  const limit = Math.min(Number(req.body.concurrency || 5), 20);
  const queue = recipients.slice();
  const results = [];

  async function worker() {
    while (queue.length) {
      const r = queue.shift();
      if (!r) continue;
      const to = assertNormalizedPhone(r.to);
      const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: to });
      const chargeAmount = windowOpen ? 0 : messageCostForTemplateCategory(template.category, 1);

      try {
        await chargeForMessaging(req.workspace.id, chargeAmount, "Message send", {
          kind: "bulk",
          templateId: String(template._id),
          to,
          pricing: { customerServiceWindowOpen: windowOpen },
        });
        const { message } = await sendTemplateMessageForUser({
          userId: req.workspace.id,
          template,
          to,
          languageCode,
          variables: r.variables,
          headerVariables: r.headerVariables,
          otpCode: r.otpCode,
          buttonValues: r.buttonValues,
          buttonTtlMinutes: r.buttonTtlMinutes,
          flowTokens: r.flowTokens,
          flowActionData: r.flowActionData,
        });

        results.push({
          to,
          success: true,
          messageId: message?.whatsappMessageId || message?._id,
        });
      } catch (err) {
        if (!err?.statusCode && err?.response) {
          try {
            await refundMessagingCharge(req.workspace.id, chargeAmount, { templateId: String(template._id), to });
          } catch {}
        }
        if (err.statusCode) {
          results.push({
            to,
            success: false,
            error: err.message,
            details: err.details || null,
          });
          continue;
        }

        await safeLogFailedOutboundMessage({
          userId: req.workspace.id,
          templateId: template._id,
          phone: to,
          err,
        });

        results.push({
          to,
          success: false,
          error: providerErrorFrom(err),
          details: buildDetails(err),
        });
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  res.json({ success: true, count: results.length, results });
}

async function sendText(req, res) {
  const { to, text } = req.body;
  const normalizedPhone = assertNormalizedPhone(to);
  const body = String(text || "").trim();
  if (!body) throw new HttpError(400, "Text is required");

  try {
    const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: normalizedPhone });
    if (!windowOpen) {
      throw new HttpError(400, "Customer service window is closed. Ask the user to message first (24h window).", {
        phone: normalizedPhone,
      });
    }
    await getCredentialsForUser(req.workspace.id);
    const result = await sendTextMessageForUser({
      userId: req.workspace.id,
      to: normalizedPhone,
      text: body,
    });
    res.json({ success: true, message: result.message, meta: result.apiResponse });
  } catch (err) {
    if (err.statusCode) throw err;
    await safeLogFailedOutboundMessage({
      userId: req.workspace.id,
      templateId: null,
      phone: normalizedPhone,
      err,
    });
    throw new HttpError(err?.response?.status || 502, "Failed to send text message", buildDetails(err));
  }
}

async function listLogs(req, res) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const skip = (page - 1) * limit;

  const filter = { workspaceId: req.workspace.id, direction: "outbound" };
  if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
  if (req.query.templateId) filter.templateId = req.query.templateId;
  if (req.query.search) {
    const q = String(req.query.search).trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ phone: rx }, { whatsappMessageId: rx }, { status: rx }, { text: rx }];
    }
  }
  const sortDir = String(req.query.sort || "desc").toLowerCase() === "asc" ? 1 : -1;

  const [items, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: sortDir, _id: sortDir }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);

  res.json({ success: true, page, limit, total, items });
}

async function messagesByPhone(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);

  const messages = await Message.find({ workspaceId: req.workspace.id, phone })
    .sort({ createdAt: -1 })
    .limit(limit);

  const templateIds = Array.from(
    new Set(
      messages
        .map((m) => (m.templateId ? String(m.templateId) : ""))
        .filter(Boolean)
    )
  );

  const templates = templateIds.length
    ? await Template.find({ _id: { $in: templateIds }, workspaceId: req.workspace.id })
    : [];
  const templateMap = new Map(templates.map((t) => [String(t._id), t]));

  const decorated = messages
    .slice()
    .reverse()
    .map((m) => {
      const obj = m.toObject();

      // Avoid "[object Object]" leaks in UI.
      const rawText = obj.text;
      if (rawText && typeof rawText !== "string") {
        obj.text = null;
      }

      if (obj.templateId) {
        const tpl = templateMap.get(String(obj.templateId));
        if (tpl) {
          const runtime = obj?.payload?.runtime || {};
          const parts = renderTemplatePreviewParts(tpl, {
            variables: runtime.variables || [],
            headerVariables: runtime.headerVariables || [],
            otpCode: runtime.otpCode || "",
          });
          obj.display = {
            kind: "template",
            header: parts.header,
            body: parts.body,
            footer: parts.footer,
            templateName: tpl.name,
            category: tpl.category,
          };
        }
      }

      if (!obj.display && typeof obj.text === "string" && obj.text.trim()) {
        obj.display = { kind: "text", body: obj.text };
      }

      return obj;
    });

  res.json({ success: true, phone, messages: decorated });
}

async function messageStatusByWaId(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  const waId = String(req.params.waId || "").trim();
  if (!waId) throw new HttpError(400, "Invalid WhatsApp message id");

  const message = await Message.findOne({
    workspaceId: req.workspace.id,
    whatsappMessageId: waId,
  });

  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message status not found yet",
      waId,
    });
  }

  return res.json({
    success: true,
    waId,
    status: message.status,
    statusTimestamps: message.statusTimestamps || {},
    message,
  });
}

module.exports = { sendTemplate, sendText, bulkSend, listLogs, messagesByPhone, messageStatusByWaId };
