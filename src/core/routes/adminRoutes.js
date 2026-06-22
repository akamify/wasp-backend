const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireAdmin } = require("@core/middleware/requireAdmin");
const { requireSuperAdmin } = require("@core/middleware/requireRole");
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
  adminSubscriptionWorkspaceOverview,
  adminSubscriptionWorkspaceHistory,
  adminSubscriptionWorkspacePaymentLinks,
  adminAssignPlanToWorkspace,
  adminCreateWorkspacePaymentLink,
  adminCancelWorkspacePaymentLink,
  adminDisableActiveWorkspacePlan,
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
  adminGetPlatformBrand,
  adminUpdatePlatformBrand,
  adminUploadPlatformBrandLogo,
} = require("@modules/admin/controllers/adminContent.controller");

const {
  adminGetProfile,
  adminUpdateProfile,
  adminListLoginEvents,
  adminCreateProfileRequest,
  adminListProfileRequests,
  adminVerifyProfileRequestOtp,
  adminResendProfileRequestOtp,
} = require("@modules/admin/controllers/adminProfile.controller");
const apiKeyAdminController = require("@modules/api-keys/controllers/apiKey.controller");
const rateLimiters = require("@core/middleware/rateLimiters");
const { validate } = require("@core/middleware/validate");
const { requireAdminPermission } = require("@core/middleware/requireAdminPermission");
const Joi = require("joi");

const {
  adminGetMasterTemplate,
  adminUpdateMasterTemplate,
  adminDeleteMasterTemplate,
  adminSyncTemplateStatus,
  adminSyncMetaTemplates,
} = require("@modules/admin/controllers/adminTemplate.controller");
const crmAdminController = require("@modules/crm/controllers/crmAdmin.controller");
const workspaceFeaturesController = require("@modules/workspaces/controllers/workspaceFeatures.controller");
const docsController = require("@modules/admin/controllers/adminDocs.controller");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const superAdminBillingRoutes = require("@modules/billing/routes/superAdminBilling.routes");
const { getMetaSecretFingerprint } = require("@modules/meta/controllers/metaAdmin.controller");

const router = express.Router();
const docsBrandUpload = buildMemoryUpload({
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
});
const platformBrandUpload = buildMemoryUpload({
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/svg+xml"],
});
const p = (key) => requireAdminPermission("page", key);
const c = (key) => requireAdminPermission("component", key);
const a = (key) => requireAdminPermission("action", key);

router.use(auth, requireAdmin);
router.use("/billing", requireSuperAdmin, superAdminBillingRoutes);
router.get("/overview", p("/admin/dashboard"), asyncHandler(adminOverview));
router.put("/settings/password", c("profile.change_password"), asyncHandler(adminChangePassword));
router.get("/users", p("/admin/users"), asyncHandler(adminListUsers));
router.patch("/users/:id/status", c("users.edit"), asyncHandler(adminUpdateUserStatus));
router.post("/users/:id/chat-access/send-otp", a("users.manage"), rateLimiters.otp, asyncHandler(apiKeyAdminController.sendChatAccessOtp));
router.post(
  "/users/:id/chat-access/verify-otp",
  a("users.manage"),
  rateLimiters.otp,
  validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })),
  asyncHandler(apiKeyAdminController.verifyChatAccessOtp)
);
router.patch("/users/:id/chat-access/enable", a("users.manage"), asyncHandler(apiKeyAdminController.enableChatAccess));
router.patch("/users/:id/chat-access/disable", a("users.manage"), asyncHandler(apiKeyAdminController.disableChatAccess));
router.patch("/users/:id/api-permissions/campaign-send/enable", a("users.manage"), asyncHandler(apiKeyAdminController.enableCampaignSend));
router.patch("/users/:id/api-permissions/campaign-send/disable", a("users.manage"), asyncHandler(apiKeyAdminController.disableCampaignSend));
router.patch("/users/:id/api-keys/:keyId/disable", a("users.manage"), asyncHandler(apiKeyAdminController.disableKey));
router.patch("/users/:id/api-keys/:keyId/enable", a("users.manage"), asyncHandler(apiKeyAdminController.enableKey));
router.patch(
  "/users/:id/api-keys/:keyId/permissions/chat-access",
  a("users.manage"),
  validate(Joi.object({ enabled: Joi.boolean().required() })),
  asyncHandler(apiKeyAdminController.setApiKeyChatAccess)
);
router.post(
  "/users/:id/api-keys/sync-chat-access",
  a("users.manage"),
  validate(Joi.object({ enabled: Joi.boolean().required() })),
  asyncHandler(apiKeyAdminController.syncUserApiKeysChatAccess)
);
router.patch("/users/:id/block", a("users.manage"), asyncHandler(apiKeyAdminController.blockUser));
router.patch("/users/:id/unblock", a("users.manage"), asyncHandler(apiKeyAdminController.unblockUser));
router.patch("/workspaces/:workspaceId/api-permissions/campaign-send/enable", a("users.manage"), asyncHandler(apiKeyAdminController.enableWorkspaceCampaignSend));
router.patch("/workspaces/:workspaceId/api-permissions/campaign-send/disable", a("users.manage"), asyncHandler(apiKeyAdminController.disableWorkspaceCampaignSend));
router.patch("/workspaces/:workspaceId/chat-access/enable", a("users.manage"), asyncHandler(apiKeyAdminController.enableWorkspaceChatAccess));
router.patch("/workspaces/:workspaceId/chat-access/disable", a("users.manage"), asyncHandler(apiKeyAdminController.disableWorkspaceChatAccess));
router.get("/channels", p("/admin/workspaces"), asyncHandler(adminListChannels));
router.get("/workspaces", p("/admin/workspaces"), asyncHandler(adminListChannels));
router.get("/master-campaigns", p("/admin/master-campaigns"), asyncHandler(adminListMasterCampaigns));
router.get("/master-templates", p("/admin/master-templates"), asyncHandler(adminListMasterTemplates));
router.get("/master-templates/:id", p("/admin/master-templates"), asyncHandler(adminGetMasterTemplate));
router.put("/master-templates/:id", c("templates.edit"), asyncHandler(adminUpdateMasterTemplate));
router.delete("/master-templates/:id", c("templates.delete"), asyncHandler(adminDeleteMasterTemplate));
router.post("/master-templates/:id/sync-status", a("templates.manage"), asyncHandler(adminSyncTemplateStatus));
router.post("/master-templates/sync-meta", a("templates.manage"), asyncHandler(adminSyncMetaTemplates));
router.get("/master-contacts", p("/admin/master-contacts"), asyncHandler(adminListMasterContacts));
router.get("/notifications", p("/admin/notifications"), asyncHandler(adminListNotifications));
router.get("/transactions-logs", p("/admin/transactions-logs"), asyncHandler(adminListTransactions));
router.get("/message-logs", p("/admin/message-logs"), asyncHandler(adminListMessageLogs));
router.get("/subscription-plans", p("/admin/subscription-plans"), asyncHandler(adminSubscriptionPlans));
router.get("/subscriptions-data", p("/admin/subscriptions-data"), asyncHandler(adminSubscriptionsData));
router.get("/subscriptions-data/:workspaceId/overview", p("/admin/subscriptions-data"), asyncHandler(adminSubscriptionWorkspaceOverview));
router.get("/subscriptions-data/:workspaceId/history", p("/admin/subscriptions-data"), asyncHandler(adminSubscriptionWorkspaceHistory));
router.get("/subscriptions-data/:workspaceId/payment-links", p("/admin/subscriptions-data"), asyncHandler(adminSubscriptionWorkspacePaymentLinks));
router.post("/subscriptions-data/:workspaceId/assign-plan", a("subscriptions.manage"), asyncHandler(adminAssignPlanToWorkspace));
router.post("/subscriptions-data/:workspaceId/disable-active-plan", a("subscriptions.manage"), asyncHandler(adminDisableActiveWorkspacePlan));
router.post("/subscriptions-data/:workspaceId/payment-links", a("subscriptions.manage"), asyncHandler(adminCreateWorkspacePaymentLink));
router.patch("/subscriptions-data/payment-links/:id/cancel", a("subscriptions.manage"), asyncHandler(adminCancelWorkspacePaymentLink));
router.get("/payment-gateway", p("/admin/billing"), asyncHandler(adminPaymentGateway));
router.get("/meta/secret-fingerprint", p("/admin/settings"), asyncHandler(getMetaSecretFingerprint));
router.get("/support-tickets", p("/admin/support-tickets"), asyncHandler(adminSupportTickets));
router.patch("/support-tickets/:id/resolve", c("tickets.edit"), asyncHandler(adminResolveSupportTicket));
router.get("/app-update", p("/admin/settings"), asyncHandler(adminAppUpdate));
router.get("/docs-feedbacks", requireAdminPermission("page", "/admin/docs"), asyncHandler(docsController.adminDocsFeedbacks));
router.get("/docs-feedbacks/:id", requireAdminPermission("page", "/admin/docs"), asyncHandler(docsController.adminDocsFeedbackGet));
router.get("/docs", requireAdminPermission("page", "/admin/docs"), asyncHandler(docsController.adminDocsList));
router.get("/docs/:id", requireAdminPermission("page", "/admin/docs"), asyncHandler(docsController.adminDocsGet));
router.post("/docs", requireAdminPermission("component", "docs.create"), asyncHandler(docsController.adminDocsCreate));
router.put("/docs/:id", requireAdminPermission("component", "docs.edit"), asyncHandler(docsController.adminDocsUpdate));
router.delete("/docs/:id", requireAdminPermission("component", "docs.delete"), asyncHandler(docsController.adminDocsDelete));
router.get("/docs-brand", requireAdminPermission("page", "/admin/docs"), asyncHandler(docsController.adminDocsBrandGet));
router.put("/docs-brand", requireAdminPermission("component", "docs.edit"), asyncHandler(docsController.adminDocsBrandUpdate));
router.post(
  "/docs-brand/upload-logo",
  requireAdminPermission("component", "docs.edit"),
  docsBrandUpload.single("file"),
  asyncHandler(docsController.adminDocsBrandUploadLogo)
);

// Admin profile
router.get("/profile", p("/admin/profile"), asyncHandler(adminGetProfile));
router.put("/profile", c("profile.edit"), asyncHandler(adminUpdateProfile));
router.get("/profile/logins", c("profile.sessions"), asyncHandler(adminListLoginEvents));
router.get("/profile/requests", p("/admin/profile"), asyncHandler(adminListProfileRequests));
router.post("/profile/requests", p("/admin/profile"), asyncHandler(adminCreateProfileRequest));
router.post("/profile/requests/:requestId/verify-otp", p("/admin/profile"), asyncHandler(adminVerifyProfileRequestOtp));
router.post("/profile/requests/:requestId/resend-otp", p("/admin/profile"), asyncHandler(adminResendProfileRequestOtp));

// Public pages (CMS)
router.get("/pages", p("/admin/pages"), asyncHandler(adminListPages));
router.get("/pages/:slug", p("/admin/pages"), asyncHandler(adminGetPage));
router.put("/pages/:slug", c("pages.edit"), asyncHandler(adminUpsertPage));
router.get("/platform-brand", p("/admin/pages"), asyncHandler(adminGetPlatformBrand));
router.put("/platform-brand", requireSuperAdmin, c("pages.edit"), asyncHandler(adminUpdatePlatformBrand));
router.post(
  "/platform-brand/upload-logo",
  requireSuperAdmin,
  c("pages.edit"),
  platformBrandUpload.single("file"),
  asyncHandler(adminUploadPlatformBrandLogo)
);

// Careers
router.get("/career-applications", p("/admin/career-applications"), asyncHandler(adminCareerApplications));
router.patch("/career-applications/:id", c("careers.edit"), asyncHandler(adminUpdateCareerApplication));
router.get("/career-applications/:id/resume", p("/admin/career-applications"), asyncHandler(adminDownloadResume));

// CRM (workspace-level toggles + employee management)
router.get("/crm/workspaces/:workspaceId", p("/admin/workspaces"), asyncHandler(crmAdminController.getWorkspaceCrm));
router.patch("/crm/workspaces/:workspaceId/enabled", c("workspaces.edit"), asyncHandler(crmAdminController.setCrmEnabled));
router.put("/crm/workspaces/:workspaceId/settings/lead-window", c("workspaces.edit"), asyncHandler(crmAdminController.setLeadWindowHours));
router.put("/crm/workspaces/:workspaceId/settings/assignment-mode", c("workspaces.edit"), asyncHandler(crmAdminController.setAssignmentMode));
router.get("/crm/workspaces/:workspaceId/employees", p("/admin/workspaces"), asyncHandler(crmAdminController.listEmployees));
router.post("/crm/workspaces/:workspaceId/employees", c("workspaces.edit"), asyncHandler(crmAdminController.createEmployee));
router.patch("/crm/workspaces/:workspaceId/employees/:employeeId/status", c("workspaces.edit"), asyncHandler(crmAdminController.updateEmployeeStatus));

// Workspace features
router.get(
  "/workspaces/:workspaceId/features/external-chat",
  p("/admin/workspaces"),
  asyncHandler(workspaceFeaturesController.getExternalChatFeature)
);
router.patch(
  "/workspaces/:workspaceId/features/external-chat",
  c("workspaces.edit"),
  validate(Joi.object({ enabled: Joi.boolean().required() })),
  asyncHandler(workspaceFeaturesController.updateExternalChatFeature)
);

module.exports = router;

