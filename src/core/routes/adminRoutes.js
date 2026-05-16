const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireAdmin } = require("@core/middleware/requireAdmin");
const {
  adminOverview,
  adminChangePassword,
} = require("@modules/admin/controllers/admin.controller");
const {
  adminListUsers,
  adminUpdateUserStatus,
  adminListChannels,
  adminListMasterCampaigns,
  adminListMasterTemplates,
  adminListMasterContacts,
  adminListNotifications,
  adminListTransactions,
  adminListMessageLogs,
  adminSubscriptionPlans,
  adminSubscriptionsData,
  adminPaymentGateway,
  adminAppUpdate,
} = require("@modules/admin/controllers/adminPanel.controller");

const {
  adminListPages,
  adminGetPage,
  adminUpsertPage,
  adminSupportTickets,
  adminResolveSupportTicket,
  adminCareerApplications,
  adminUpdateCareerApplication,
  adminDownloadResume,
} = require("@modules/admin/controllers/adminContent.controller");

const {
  adminGetProfile,
  adminUpdateProfile,
  adminListLoginEvents,
} = require("@modules/admin/controllers/adminProfile.controller");
const apiKeyAdminController = require("@modules/api-keys/controllers/apiKey.controller");
const rateLimiters = require("@core/middleware/rateLimiters");
const { validate } = require("@core/middleware/validate");
const Joi = require("joi");

const {
  adminGetMasterTemplate,
  adminUpdateMasterTemplate,
  adminDeleteMasterTemplate,
  adminSyncTemplateStatus,
  adminSyncMetaTemplates,
} = require("@modules/admin/controllers/adminTemplate.controller");

const router = express.Router();

router.use(auth, requireAdmin);
router.get("/overview", asyncHandler(adminOverview));
router.put("/settings/password", asyncHandler(adminChangePassword));
router.get("/users", asyncHandler(adminListUsers));
router.patch("/users/:id/status", asyncHandler(adminUpdateUserStatus));
router.post("/users/:id/chat-access/send-otp", rateLimiters.otp, asyncHandler(apiKeyAdminController.sendChatAccessOtp));
router.post(
  "/users/:id/chat-access/verify-otp",
  rateLimiters.otp,
  validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })),
  asyncHandler(apiKeyAdminController.verifyChatAccessOtp)
);
router.patch("/users/:id/chat-access/enable", asyncHandler(apiKeyAdminController.enableChatAccess));
router.patch("/users/:id/chat-access/disable", asyncHandler(apiKeyAdminController.disableChatAccess));
router.patch("/users/:id/api-permissions/campaign-send/enable", asyncHandler(apiKeyAdminController.enableCampaignSend));
router.patch("/users/:id/api-permissions/campaign-send/disable", asyncHandler(apiKeyAdminController.disableCampaignSend));
router.patch("/users/:id/api-keys/:keyId/disable", asyncHandler(apiKeyAdminController.disableKey));
router.patch("/users/:id/api-keys/:keyId/enable", asyncHandler(apiKeyAdminController.enableKey));
router.patch("/users/:id/block", asyncHandler(apiKeyAdminController.blockUser));
router.patch("/users/:id/unblock", asyncHandler(apiKeyAdminController.unblockUser));
router.get("/channels", asyncHandler(adminListChannels));
router.get("/workspaces", asyncHandler(adminListChannels));
router.get("/master-campaigns", asyncHandler(adminListMasterCampaigns));
router.get("/master-templates", asyncHandler(adminListMasterTemplates));
router.get("/master-templates/:id", asyncHandler(adminGetMasterTemplate));
router.put("/master-templates/:id", asyncHandler(adminUpdateMasterTemplate));
router.delete("/master-templates/:id", asyncHandler(adminDeleteMasterTemplate));
router.post("/master-templates/:id/sync-status", asyncHandler(adminSyncTemplateStatus));
router.post("/master-templates/sync-meta", asyncHandler(adminSyncMetaTemplates));
router.get("/master-contacts", asyncHandler(adminListMasterContacts));
router.get("/notifications", asyncHandler(adminListNotifications));
router.get("/transactions-logs", asyncHandler(adminListTransactions));
router.get("/message-logs", asyncHandler(adminListMessageLogs));
router.get("/subscription-plans", asyncHandler(adminSubscriptionPlans));
router.get("/subscriptions-data", asyncHandler(adminSubscriptionsData));
router.get("/payment-gateway", asyncHandler(adminPaymentGateway));
router.get("/support-tickets", asyncHandler(adminSupportTickets));
router.patch("/support-tickets/:id/resolve", asyncHandler(adminResolveSupportTicket));
router.get("/app-update", asyncHandler(adminAppUpdate));

// Admin profile
router.get("/profile", asyncHandler(adminGetProfile));
router.put("/profile", asyncHandler(adminUpdateProfile));
router.get("/profile/logins", asyncHandler(adminListLoginEvents));

// Public pages (CMS)
router.get("/pages", asyncHandler(adminListPages));
router.get("/pages/:slug", asyncHandler(adminGetPage));
router.put("/pages/:slug", asyncHandler(adminUpsertPage));

// Careers
router.get("/career-applications", asyncHandler(adminCareerApplications));
router.patch("/career-applications/:id", asyncHandler(adminUpdateCareerApplication));
router.get("/career-applications/:id/resume", asyncHandler(adminDownloadResume));

module.exports = router;

