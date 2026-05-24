const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireAdmin } = require("@core/middleware/requireAdmin");
const { validate } = require("@core/middleware/validate");
const rateLimiters = require("@core/middleware/rateLimiters");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const c = require("@modules/api-keys/controllers/apiKey.controller");

const router = express.Router();
const requireApiKeysAccess = requireBillingFeature("apiKeysPageAccess", {
  message: "Your current plan does not include API keys access.",
});

router.use(auth);

router.get("/", requireWorkspace, requireApiKeysAccess, asyncHandler(c.listApiKeys));
router.post("/generate", requireWorkspace, requireApiKeysAccess, validate(Joi.object({ name: Joi.string().trim().max(80).optional() })), asyncHandler(c.generateApiKey));
router.post("/regenerate", requireWorkspace, requireApiKeysAccess, validate(Joi.object({ keyId: Joi.string().optional(), name: Joi.string().trim().max(80).optional() })), asyncHandler(c.regenerateApiKey));
router.delete("/:id", requireWorkspace, requireApiKeysAccess, asyncHandler(c.deleteApiKey));

router.post("/admin/users/:id/chat-access/send-otp", requireAdmin, rateLimiters.otp, asyncHandler(c.sendChatAccessOtp));
router.get("/admin/users/:id", requireAdmin, asyncHandler(c.listUserApiKeys));
router.post("/admin/users/:id/chat-access/verify-otp", requireAdmin, rateLimiters.otp, validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })), asyncHandler(c.verifyChatAccessOtp));
router.patch("/admin/users/:id/chat-access/disable", requireAdmin, asyncHandler(c.disableChatAccess));
router.patch("/admin/users/:id/api-keys/:keyId/disable", requireAdmin, asyncHandler(c.disableKey));
router.patch("/admin/users/:id/api-keys/:keyId/enable", requireAdmin, asyncHandler(c.enableKey));
router.patch(
  "/admin/users/:id/api-keys/:keyId/permissions/chat-access",
  requireAdmin,
  validate(Joi.object({ enabled: Joi.boolean().required() })),
  asyncHandler(c.setApiKeyChatAccess)
);
router.post(
  "/admin/users/:id/api-keys/sync-chat-access",
  requireAdmin,
  validate(Joi.object({ enabled: Joi.boolean().required() })),
  asyncHandler(c.syncUserApiKeysChatAccess)
);
router.patch("/admin/users/:id/block", requireAdmin, asyncHandler(c.blockUser));
router.patch("/admin/users/:id/unblock", requireAdmin, asyncHandler(c.unblockUser));

module.exports = router;
