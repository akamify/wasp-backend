const { Template } = require("../models/Template");
const { Message } = require("../models/Message");
const { HttpError } = require("../utils/httpError");
const { sendTemplateMessageForUser, sendTextMessageForUser } = require("../services/outboundMessageService");
const { getCredentialsForUser } = require("../services/credentialsService");
const { assertNormalizedPhone, normalizePhone } = require("../services/contactService");
const { debit, credit, messageCostForTemplateCategory } = require("../services/walletService");

function isDuplicateKeyError(err) {
  return err?.code === 11000 || err?.name === "MongoServerError";
}

function providerErrorFrom(err) {
  return (
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

  const chargeAmount = messageCostForTemplateCategory(template.category, 1);
  try {
    await debit(req.workspace.id, chargeAmount, "Message send", {
      kind: "single",
      templateId: String(template._id),
      to: normalizedPhone,
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
        await credit(req.workspace.id, chargeAmount, "Message refund (send failed)", "internal", "", {
          templateId: templateId,
          to: normalizedPhone,
        });
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
      const chargeAmount = messageCostForTemplateCategory(template.category, 1);

      try {
        await debit(req.workspace.id, chargeAmount, "Message send", {
          kind: "bulk",
          templateId: String(template._id),
          to,
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
            await credit(req.workspace.id, chargeAmount, "Message refund (send failed)", "internal", "", {
              templateId: String(template._id),
              to,
            });
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
  if (req.query.status) filter.status = req.query.status;
  if (req.query.templateId) filter.templateId = req.query.templateId;

  const [items, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
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

  res.json({ success: true, phone, messages: messages.reverse() });
}

async function messageStatusByWaId(req, res) {
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
