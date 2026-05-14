const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { auth } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/requireAdmin");
const {
  adminOverview,
  adminChangePassword,
} = require("../controllers/adminController");
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
} = require("../controllers/adminPanelController");

const {
  adminListPages,
  adminGetPage,
  adminUpsertPage,
  adminSupportTickets,
  adminResolveSupportTicket,
  adminCareerApplications,
  adminUpdateCareerApplication,
  adminDownloadResume,
} = require("../controllers/adminContentController");

const {
  adminGetProfile,
  adminUpdateProfile,
  adminListLoginEvents,
} = require("../controllers/adminProfileController");

const {
  adminGetMasterTemplate,
  adminUpdateMasterTemplate,
  adminDeleteMasterTemplate,
  adminSyncTemplateStatus,
  adminSyncMetaTemplates,
} = require("../controllers/adminTemplateController");

const router = express.Router();

router.use(auth, requireAdmin);
router.get("/overview", asyncHandler(adminOverview));
router.put("/settings/password", asyncHandler(adminChangePassword));
router.get("/users", asyncHandler(adminListUsers));
router.patch("/users/:id/status", asyncHandler(adminUpdateUserStatus));
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
