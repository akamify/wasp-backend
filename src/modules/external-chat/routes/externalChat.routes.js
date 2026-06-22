const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const rateLimiters = require("@core/middleware/rateLimiters");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { externalChatApiKeyAuth } = require("@modules/external-chat/middleware/externalChatApiKeyAuth");
const { requireExternalChatWorkspace } = require("@modules/external-chat/middleware/requireExternalChatWorkspace");
const { requireExternalChatAccess } = require("@modules/external-chat/middleware/requireExternalChatAccess");
const {
  listConversations,
  listConversationMessages,
  readConversation,
  uploadMedia,
  sendText,
  sendMedia,
  listContacts,
  getContact,
  updateContact,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  issueRealtimeToken,
  streamRealtime,
} = require("@modules/external-chat/controllers/externalChat.controller");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/aac",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
});

const requireExternalAuthChain = [externalChatApiKeyAuth, requireExternalChatWorkspace, requireExternalChatAccess];
const contactPayloadSchema = Joi.object({
  name: Joi.string().trim().max(120).allow("").optional(),
  email: Joi.string().trim().email().max(160).allow("").optional(),
  company: Joi.string().trim().max(160).allow("").optional(),
  tags: Joi.array().items(Joi.string().trim().max(40)).max(25).optional(),
  attributes: Joi.object().max(50).optional(),
}).optional();
const webhookPayloadSchema = Joi.object({
  url: Joi.string().uri({ scheme: ["http", "https"] }).max(2000).required(),
  events: Joi.array()
    .items(Joi.string().valid("message.created", "message.status_updated", "conversation.updated", "contact.updated"))
    .min(1)
    .max(4)
    .optional(),
});
const webhookUpdateSchema = Joi.object({
  url: Joi.string().uri({ scheme: ["http", "https"] }).max(2000).optional(),
  events: Joi.array()
    .items(Joi.string().valid("message.created", "message.status_updated", "conversation.updated", "contact.updated"))
    .min(1)
    .max(4)
    .optional(),
  enabled: Joi.boolean().optional(),
}).min(1);

router.get("/conversations", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(listConversations));
router.get(
  "/conversations/:phone/messages",
  ...requireExternalAuthChain,
  rateLimiters.externalChatRead,
  asyncHandler(listConversationMessages)
);
router.post("/conversations/:phone/read", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(readConversation));
router.get("/contacts", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(listContacts));
router.get("/contacts/:phone", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(getContact));
router.patch(
  "/contacts/:phone",
  ...requireExternalAuthChain,
  rateLimiters.externalChatRead,
  validate(contactPayloadSchema.required()),
  asyncHandler(updateContact)
);

router.get("/webhooks", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(listWebhooks));
router.post("/webhooks", ...requireExternalAuthChain, rateLimiters.externalChatRead, validate(webhookPayloadSchema), asyncHandler(createWebhook));
router.patch("/webhooks/:id", ...requireExternalAuthChain, rateLimiters.externalChatRead, validate(webhookUpdateSchema), asyncHandler(updateWebhook));
router.delete("/webhooks/:id", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(deleteWebhook));
router.post("/webhooks/:id/rotate-secret", ...requireExternalAuthChain, rateLimiters.externalChatRead, asyncHandler(rotateWebhookSecret));

router.post(
  "/media",
  ...requireExternalAuthChain,
  rateLimiters.externalChatUpload,
  upload.single("file"),
  asyncHandler(uploadMedia)
);

router.post(
  "/messages/send-text",
  ...requireExternalAuthChain,
  rateLimiters.externalChatSend,
  validate(
    Joi.object({
      to: Joi.string().min(8).max(20).required(),
      text: Joi.string().trim().min(1).max(4096).required(),
      contact: contactPayloadSchema,
    })
  ),
  asyncHandler(sendText)
);

router.post(
  "/messages/send-media",
  ...requireExternalAuthChain,
  rateLimiters.externalChatSend,
  validate(
    Joi.object({
      to: Joi.string().min(8).max(20).required(),
      type: Joi.string().valid("image", "video", "audio", "document").required(),
      mediaId: Joi.string().min(3).optional(),
      link: Joi.string().uri().optional(),
      caption: Joi.string().allow("").max(1024).optional(),
      filename: Joi.string().allow("").max(200).optional(),
      contact: contactPayloadSchema,
    }).or("mediaId", "link")
  ),
  asyncHandler(sendMedia)
);

router.post("/realtime/token", ...requireExternalAuthChain, rateLimiters.externalChatRealtimeToken, asyncHandler(issueRealtimeToken));
router.get("/realtime/stream", rateLimiters.externalChatRead, asyncHandler(streamRealtime));

router.use((err, req, res, next) => {
  const statusCode = Number(err?.statusCode || 500);
  const message = String(err?.message || "Internal server error");
  const data = {};

  if (err?.details && typeof err.details === "object") {
    Object.assign(data, err.details);
  }

  return res.status(statusCode).json({
    success: false,
    message,
    data,
  });
});

module.exports = router;
