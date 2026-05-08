const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const {
  sendTemplate,
  sendText,
  bulkSend,
  listLogs,
  messagesByPhone,
  messageStatusByWaId,
} = require("../controllers/messageController");
const { listWebhookDebugEvents } = require("../controllers/webhookController");
const { uploadMessageMedia, downloadMessageMedia } = require("../controllers/messageMediaController");
const { buildMemoryUpload } = require("../utils/multerUpload");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: [
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
});

router.post("/media", auth, requireWorkspace, upload.single("file"), asyncHandler(uploadMessageMedia));
router.get("/media/:id", auth, requireWorkspace, asyncHandler(downloadMessageMedia));

router.post(
  "/send",
  auth,
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
  "/bulk",
  auth,
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

router.get("/logs", auth, requireWorkspace, asyncHandler(listLogs));
router.get("/status/:waId", auth, requireWorkspace, asyncHandler(messageStatusByWaId));
const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const debugFeedEnabled = String(process.env.META_WEBHOOK_DEBUG_FEED_ENABLED || "").toLowerCase() === "true";
if (!isProd || debugFeedEnabled) {
  router.get("/webhook-debug", auth, requireWorkspace, asyncHandler(listWebhookDebugEvents));
}
router.get("/:phone", auth, requireWorkspace, asyncHandler(messagesByPhone));

module.exports = router;
