const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const { assertNormalizedPhone } = require("@shared/services/contactService");
const { isCustomerServiceWindowOpen } = require("@shared/services/pricingService");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { sendTextMessageForUser, sendMediaMessageForUser } = require("@shared/services/outboundMessageService");
const { publishWorkspaceEvent } = require("@shared/services/realtimeService");

const sendTextSchema = Joi.object({
  to: Joi.string().min(8).max(20).required(),
  text: Joi.string().trim().min(1).max(4096).required(),
});

async function sendText(req, res) {
  const payload = await sendTextSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const normalizedPhone = assertNormalizedPhone(payload.to);

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
    text: payload.text,
    sentBy: { kind: "employee", actorId: req.employee.id },
  });

  res.json({ success: true, message: result.message, meta: result.apiResponse });
  publishWorkspaceEvent(req.workspace.id, {
    type: "message_outbound",
    phone: normalizedPhone,
    messageId: result?.message?._id ? String(result.message._id) : null,
    whatsappMessageId: result?.message?.whatsappMessageId || null,
  });
}

const sendMediaSchema = Joi.object({
  to: Joi.string().min(8).max(20).required(),
  type: Joi.string().valid("image", "video", "audio", "document").required(),
  mediaId: Joi.string().min(3).optional(),
  link: Joi.string().uri().optional(),
  caption: Joi.string().allow("").max(1024).optional(),
  filename: Joi.string().allow("").max(200).optional(),
}).or("mediaId", "link");

async function sendMedia(req, res) {
  const payload = await sendMediaSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const normalizedPhone = assertNormalizedPhone(payload.to);

  const windowOpen = await isCustomerServiceWindowOpen({ workspaceId: req.workspace.id, phone: normalizedPhone });
  if (!windowOpen) {
    throw new HttpError(400, "Customer service window is closed. Ask the user to message first (24h window).", {
      phone: normalizedPhone,
    });
  }

  await getCredentialsForUser(req.workspace.id);
  const result = await sendMediaMessageForUser({
    userId: req.workspace.id,
    to: normalizedPhone,
    type: payload.type,
    mediaId: payload.mediaId,
    link: payload.link,
    caption: payload.caption,
    filename: payload.filename,
    sentBy: { kind: "employee", actorId: req.employee.id },
  });

  res.json({ success: true, message: result.message, meta: result.apiResponse });
  publishWorkspaceEvent(req.workspace.id, {
    type: "message_outbound",
    phone: normalizedPhone,
    messageId: result?.message?._id ? String(result.message._id) : null,
    whatsappMessageId: result?.message?.whatsappMessageId || null,
  });
}

module.exports = { sendText, sendMedia, sendTextSchema, sendMediaSchema };

