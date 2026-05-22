const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { blockInternalChatForApiKey } = require("@core/middleware/blockInternalChatForApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const {
  sendTemplate,
  sendText,
  sendMedia,
  bulkSend,
  listLogs,
  messagesByPhone,
  messageStatusByWaId,
} = require("@modules/messages/controllers/message.controller");
const { listWebhookDebugEvents } = require("@modules/webhooks/controllers/webhook.controller");
const { uploadMessageMedia, downloadMessageMedia } = require("@modules/messages/controllers/messageMedia.controller");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");

const router = express.Router();
const requireActivityAccess = requireBillingFeature("activityPageAccess", {
  message: "Your current plan does not include activity logs access.",
});
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

router.post("/media", auth, blockInternalChatForApiKey, requireWorkspace, upload.single("file"), asyncHandler(uploadMessageMedia));
router.get("/media/:id", auth, blockInternalChatForApiKey, requireWorkspace, asyncHandler(downloadMessageMedia));

router.post(
  "/send",
  auth,
  blockInternalChatForApiKey,
  requireWorkspace,
  validate(
    Joi.object({
      templateId: Joi.string().required(),
      to: Joi.string().min(8).max(20).required(),
      languageCode: Joi.string().min(2).max(20).optional(),

      // For utility / marketing
      variables: Joi.array().items(Joi.string().allow("")).optional(),
      headerVariables: Joi.array().items(Joi.string().allow("")).optional(),

      // For authentication
      otpCode: Joi.string().trim().min(1).optional(),

      buttonValues: Joi.array().items(Joi.string().allow("")).optional(),
      buttonTtlMinutes: Joi.array().items(Joi.number().integer().min(1).max(43200)).optional(),
      flowTokens: Joi.array().items(Joi.string().max(512).allow("")).optional(),
      flowActionData: Joi.array().items(Joi.object().unknown(true)).optional(),
    })
  ),
  asyncHandler(sendTemplate)
);

router.post(
  "/send-text",
  auth,
  blockInternalChatForApiKey,
  requireWorkspace,
  validate(
    Joi.object({
      to: Joi.string().min(8).max(20).required(),
      text: Joi.string().trim().min(1).max(4096).required(),
    })
  ),
  asyncHandler(sendText)
);

router.post(
  "/send-media",
  auth,
  blockInternalChatForApiKey,
  requireWorkspace,
  validate(
    Joi.object({
      to: Joi.string().min(8).max(20).required(),
      type: Joi.string().valid("image", "video", "audio", "document").required(),
      mediaId: Joi.string().min(3).optional(),
      link: Joi.string().uri().optional(),
      caption: Joi.string().allow("").max(1024).optional(),
      filename: Joi.string().allow("").max(200).optional(),
    }).or("mediaId", "link")
  ),
  asyncHandler(sendMedia)
);

router.post(
  "/bulk",
  auth,
  blockInternalChatForApiKey,
  requireWorkspace,
  validate(
    Joi.object({
      templateId: Joi.string().required(),
      languageCode: Joi.string().min(2).max(20).optional(),
      concurrency: Joi.number().integer().min(1).max(20).optional(),
      recipients: Joi.array()
        .items(
          Joi.object({
            to: Joi.string().min(8).max(20).required(),
            variables: Joi.array().items(Joi.string().allow("")).optional(),
            headerVariables: Joi.array().items(Joi.string().allow("")).optional(),
            otpCode: Joi.string().trim().min(1).optional(),
            buttonValues: Joi.array().items(Joi.string().allow("")).optional(),
            buttonTtlMinutes: Joi.array().items(Joi.number().integer().min(1).max(43200)).optional(),
            flowTokens: Joi.array().items(Joi.string().max(512).allow("")).optional(),
            flowActionData: Joi.array().items(Joi.object().unknown(true)).optional(),
          }).required()
        )
        .min(1)
        .required(),
    })
  ),
  asyncHandler(bulkSend)
);

router.get("/logs", auth, blockInternalChatForApiKey, requireWorkspace, requireActivityAccess, asyncHandler(listLogs));
router.get("/status/:waId", auth, blockInternalChatForApiKey, requireWorkspace, asyncHandler(messageStatusByWaId));
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const debugFeedEnabled = String(process.env.META_WEBHOOK_DEBUG_FEED_ENABLED || "").toLowerCase() === "true";
if (!isProd || debugFeedEnabled) {
  router.get("/webhook-debug", auth, blockInternalChatForApiKey, requireWorkspace, requireActivityAccess, asyncHandler(listWebhookDebugEvents));
}
router.get("/:phone", auth, blockInternalChatForApiKey, requireWorkspace, asyncHandler(messagesByPhone));

module.exports = router;

