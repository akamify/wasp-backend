const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireAdmin } = require("@core/middleware/requireAdmin");
const { validate } = require("@core/middleware/validate");
const rateLimiters = require("@core/middleware/rateLimiters");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const c = require("@modules/api-keys/controllers/apiKey.controller");

const router = express.Router();

router.use(auth);

router.get("/", requireWorkspace, asyncHandler(c.listApiKeys));
router.post("/generate", requireWorkspace, validate(Joi.object({ name: Joi.string().trim().max(80).optional() })), asyncHandler(c.generateApiKey));
router.post("/regenerate", requireWorkspace, validate(Joi.object({ keyId: Joi.string().optional(), name: Joi.string().trim().max(80).optional() })), asyncHandler(c.regenerateApiKey));
router.delete("/:id", requireWorkspace, asyncHandler(c.deleteApiKey));

router.post("/admin/users/:id/chat-access/send-otp", requireAdmin, rateLimiters.otp, asyncHandler(c.sendChatAccessOtp));
router.get("/admin/users/:id", requireAdmin, asyncHandler(c.listUserApiKeys));
router.post("/admin/users/:id/chat-access/verify-otp", requireAdmin, rateLimiters.otp, validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })), asyncHandler(c.verifyChatAccessOtp));
router.patch("/admin/users/:id/chat-access/disable", requireAdmin, asyncHandler(c.disableChatAccess));
router.patch("/admin/users/:id/api-keys/:keyId/disable", requireAdmin, asyncHandler(c.disableKey));
router.patch("/admin/users/:id/api-keys/:keyId/enable", requireAdmin, asyncHandler(c.enableKey));
router.patch("/admin/users/:id/block", requireAdmin, asyncHandler(c.blockUser));
router.patch("/admin/users/:id/unblock", requireAdmin, asyncHandler(c.unblockUser));

module.exports = router;
