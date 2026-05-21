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
const docsController = require("@modules/admin/controllers/adminDocs.controller");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");

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
router.get("/overview", p("/admin/dashboard"), asyncHandler(adminOverview));
router.put("/settings/password", c("profile.change_password"), asyncHandler(adminChangePassword));
router.get("/users", requireSuperAdmin, p("/admin/users"), asyncHandler(adminListUsers));
router.patch("/users/:id/status", requireSuperAdmin, c("users.edit"), asyncHandler(adminUpdateUserStatus));
router.post("/users/:id/chat-access/send-otp", requireSuperAdmin, a("users.manage"), rateLimiters.otp, asyncHandler(apiKeyAdminController.sendChatAccessOtp));
router.post(
  "/users/:id/chat-access/verify-otp",
  requireSuperAdmin,
  a("users.manage"),
  rateLimiters.otp,
  validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })),
  asyncHandler(apiKeyAdminController.verifyChatAccessOtp)
);
router.patch("/users/:id/chat-access/enable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.enableChatAccess));
router.patch("/users/:id/chat-access/disable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.disableChatAccess));
router.patch("/users/:id/api-permissions/campaign-send/enable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.enableCampaignSend));
router.patch("/users/:id/api-permissions/campaign-send/disable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.disableCampaignSend));
router.patch("/users/:id/api-keys/:keyId/disable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.disableKey));
router.patch("/users/:id/api-keys/:keyId/enable", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.enableKey));
router.patch("/users/:id/block", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.blockUser));
router.patch("/users/:id/unblock", requireSuperAdmin, a("users.manage"), asyncHandler(apiKeyAdminController.unblockUser));
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
router.get("/payment-gateway", p("/admin/billing"), asyncHandler(adminPaymentGateway));
router.get("/support-tickets", p("/admin/support-tickets"), asyncHandler(adminSupportTickets));
router.patch("/support-tickets/:id/resolve", c("tickets.edit"), asyncHandler(adminResolveSupportTicket));
router.get("/app-update", p("/admin/settings"), asyncHandler(adminAppUpdate));
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
router.get("/crm/workspaces/:workspaceId/employees", p("/admin/workspaces"), asyncHandler(crmAdminController.listEmployees));
router.post("/crm/workspaces/:workspaceId/employees", c("workspaces.edit"), asyncHandler(crmAdminController.createEmployee));
router.patch("/crm/workspaces/:workspaceId/employees/:employeeId/status", c("workspaces.edit"), asyncHandler(crmAdminController.updateEmployeeStatus));

module.exports = router;

