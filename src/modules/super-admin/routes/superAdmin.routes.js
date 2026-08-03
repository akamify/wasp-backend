const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireSuperAdmin } = require("@core/middleware/requireRole");
const { validate } = require("@core/middleware/validate");
const c = require("@modules/super-admin/controllers/superAdmin.controller");
const platformSettingsRoutes = require("@modules/platform-settings/routes/platformSettings.routes");
const platformAddonsRoutes = require("@modules/platform-settings/routes/platformAddons.routes");
const superAdminBillingRoutes = require("@modules/billing/routes/superAdminBilling.routes");
const aiAddonAdminController = require("@modules/ai-agents/controllers/aiAddonAdmin.controller");
const billingAdminController = require("@modules/billing/controllers/billing.admin.controller");

const router = express.Router();

router.use(auth, requireSuperAdmin);
router.use("/platform-settings", platformSettingsRoutes);
router.use("/platform-addons", platformAddonsRoutes);
router.use("/billing", superAdminBillingRoutes);

router.get("/profile", asyncHandler(c.profile));
router.patch("/profile/name", validate(Joi.object({ name: Joi.string().min(2).max(120).required() })), asyncHandler(c.updateProfileName));
router.post(
  "/profile/change-password",
  validate(Joi.object({ currentPassword: Joi.string().required(), newPassword: Joi.string().min(8).required() })),
  asyncHandler(c.changeProfilePassword)
);
router.post(
  "/profile/request-otp",
  validate(Joi.object({ purpose: Joi.string().valid("change_email", "change_phone").required(), email: Joi.string().email().optional(), phone: Joi.string().optional() })),
  asyncHandler(c.requestProfileOtp)
);
router.post("/profile/verify-otp", validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })), asyncHandler(c.verifyProfileOtp));
router.patch("/profile/2fa", validate(Joi.object({ enabled: Joi.boolean().required() })), asyncHandler(c.setProfile2fa));

router.get("/admins", asyncHandler(c.listAdmins));
router.get("/admins/:id", asyncHandler(c.getAdminDetail));
router.patch("/admins/:id", asyncHandler(c.updateAdmin));
router.post(
  "/admins/:id/profile-requests/:requestId/decision",
  validate(Joi.object({ decision: Joi.string().valid("approved", "rejected").required(), reviewNote: Joi.string().allow("").optional() })),
  asyncHandler(c.decideAdminProfileRequest)
);
router.post(
  "/admins/assign",
  validate(Joi.object({ email: Joi.string().email().required(), name: Joi.string().min(2).max(120).allow("").optional() })),
  asyncHandler(c.assignAdmin)
);
router.post(
  "/admins/remove",
  validate(Joi.object({ userId: Joi.string().required() })),
  asyncHandler(c.removeAdmin)
);
router.post(
  "/users/suspend",
  validate(Joi.object({ userId: Joi.string().required(), reason: Joi.string().valid("retired", "fired").optional() })),
  asyncHandler(c.suspendUser)
);
router.post(
  "/users/reset-password",
  validate(Joi.object({ userId: Joi.string().required() })),
  asyncHandler(c.resetUserPassword)
);
router.post("/workspaces/:workspaceId/whatsapp/connection/force-embedded-active", asyncHandler(c.forceEmbeddedActiveWhatsAppConnection));
router.get("/security-logs", asyncHandler(c.securityLogs));
router.post(
  "/subscriptions-data/:workspaceId/activate-plan",
  validate(Joi.object({ reason: Joi.string().allow("").optional() })),
  asyncHandler(billingAdminController.superAdminActivateWorkspacePlan)
);
router.post(
  "/subscriptions-data/:workspaceId/block-workspace",
  validate(Joi.object({ reason: Joi.string().allow("").optional() })),
  asyncHandler(billingAdminController.superAdminBlockWorkspacePlan)
);
router.post(
  "/subscriptions-data/:workspaceId/delete-assignment",
  validate(Joi.object({ reason: Joi.string().allow("").optional() })),
  asyncHandler(billingAdminController.superAdminDeleteWorkspacePlanAssignment)
);

const aiPlanSchema = Joi.object({
  planKey: Joi.string().min(2).max(80).allow("").optional(),
  name: Joi.string().min(2).max(120).required(),
  description: Joi.string().allow("").optional(),
  status: Joi.string().valid("draft", "published", "archived", "disabled").optional(),
  currency: Joi.string().min(3).max(8).optional(),
  monthlyPrice: Joi.number().min(0).required(),
  includedCredits: Joi.number().integer().min(0).required(),
  tokensPerCredit: Joi.number().integer().min(1).required(),
  durationDays: Joi.number().integer().min(1).required(),
  limits: Joi.object({
    maxAgents: Joi.number().integer().min(0).required(),
    maxKbStorageMb: Joi.number().integer().min(0).required(),
    maxInputTokens: Joi.number().integer().min(1).required(),
    maxTokensPerReply: Joi.number().integer().min(1).required(),
  }).required(),
  renewalPolicy: Joi.object({
    mode: Joi.string().valid("auto_renew", "manual").required(),
    expireUnusedCredits: Joi.boolean().required(),
  }).required(),
  sortOrder: Joi.number().integer().min(0).optional(),
  featured: Joi.boolean().optional(),
  isDefault: Joi.boolean().optional(),
});

const aiTopupPackSchema = Joi.object({
  packId: Joi.string().min(2).max(80).allow("").optional(),
  label: Joi.string().min(2).max(120).required(),
  description: Joi.string().allow("").optional(),
  status: Joi.string().valid("draft", "published", "archived", "disabled").optional(),
  currency: Joi.string().min(3).max(8).optional(),
  credits: Joi.number().integer().min(1).required(),
  price: Joi.number().min(0).required(),
  sortOrder: Joi.number().integer().min(0).optional(),
  featured: Joi.boolean().optional(),
});

const aiProviderConfigSchema = Joi.object({
  defaultModel: Joi.string().trim().min(2).max(120).required(),
  manualModeEnabled: Joi.boolean().optional(),
  models: Joi.array().items(
    Joi.object({
      key: Joi.string().trim().min(2).max(120).required(),
      label: Joi.string().trim().min(2).max(160).required(),
      deprecated: Joi.boolean().optional(),
      sortOrder: Joi.number().integer().min(0).optional(),
    })
  ).min(1).required(),
});

const aiFinancialActionSchema = Joi.object({
  type: Joi.string().valid("refund", "adjustment").required(),
  credits: Joi.number().min(-100000).max(100000).invalid(0).required(),
  reason: Joi.string().trim().max(500).required(),
  reference: Joi.string().trim().max(160).allow("").optional(),
});

const aiAdminFinancialQuerySchema = Joi.object({
  preset: Joi.string().valid("today", "yesterday", "last_7_days", "last_30_days", "custom").allow("").optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  workspaceId: Joi.string().trim().allow("").optional(),
  agentId: Joi.string().trim().allow("").optional(),
  channel: Joi.string().valid("test", "whatsapp", "api").allow("").optional(),
  limit: Joi.number().integer().min(1).max(250).optional(),
  reportType: Joi.string()
    .valid("top_consuming_workspaces", "top_consuming_agents", "refund_summary", "adjustment_summary", "revenue_summary")
    .allow("")
    .optional(),
  format: Joi.string().valid("json", "csv").allow("").optional(),
});

router.get("/ai-addon/workspaces", asyncHandler(aiAddonAdminController.workspaceLookup));
router.get("/ai-addon/provider-config", asyncHandler(aiAddonAdminController.getProviderConfig));
router.put("/ai-addon/provider-config", validate(aiProviderConfigSchema), asyncHandler(aiAddonAdminController.updateProviderConfig));
router.get("/ai-addon/plans", asyncHandler(aiAddonAdminController.listPlans));
router.post("/ai-addon/plans", validate(aiPlanSchema), asyncHandler(aiAddonAdminController.createPlan));
router.put("/ai-addon/plans/:planId", validate(aiPlanSchema), asyncHandler(aiAddonAdminController.updatePlan));
router.post("/ai-addon/plans/:planId/publish", asyncHandler(aiAddonAdminController.publishPlan));
router.post("/ai-addon/plans/:planId/disable", asyncHandler(aiAddonAdminController.disablePlan));
router.post("/ai-addon/plans/:planId/archive", asyncHandler(aiAddonAdminController.archivePlan));
router.delete("/ai-addon/plans/:planId", asyncHandler(aiAddonAdminController.deletePlan));
router.get("/ai-addon/topup-packs", asyncHandler(aiAddonAdminController.listTopupPacks));
router.post("/ai-addon/topup-packs", validate(aiTopupPackSchema), asyncHandler(aiAddonAdminController.createTopupPack));
router.put("/ai-addon/topup-packs/:packId", validate(aiTopupPackSchema), asyncHandler(aiAddonAdminController.updateTopupPack));
router.post("/ai-addon/topup-packs/:packId/publish", asyncHandler(aiAddonAdminController.publishTopupPack));
router.post("/ai-addon/topup-packs/:packId/disable", asyncHandler(aiAddonAdminController.disableTopupPack));
router.post("/ai-addon/topup-packs/:packId/archive", asyncHandler(aiAddonAdminController.archiveTopupPack));
router.delete("/ai-addon/topup-packs/:packId", asyncHandler(aiAddonAdminController.deleteTopupPack));
router.get("/ai-addon/subscriptions", asyncHandler(aiAddonAdminController.listSubscriptions));
router.get("/ai-addon/financial-dashboard", validate(aiAdminFinancialQuerySchema, "query"), asyncHandler(aiAddonAdminController.financialDashboard));
router.get("/ai-addon/ledger", validate(aiAdminFinancialQuerySchema, "query"), asyncHandler(aiAddonAdminController.ledgerHistory));
router.get("/ai-addon/statements", validate(Joi.object({ workspaceId: Joi.string().required(), page: Joi.number().integer().min(1).optional(), limit: Joi.number().integer().min(1).max(24).optional(), period: Joi.string().pattern(/^\d{4}-\d{2}$/).allow("").optional() }), "query"), asyncHandler(aiAddonAdminController.statements));
router.get("/ai-addon/reports", validate(aiAdminFinancialQuerySchema, "query"), asyncHandler(aiAddonAdminController.adminReport));
router.post(
  "/ai-addon/workspaces/:workspaceId/assign-plan",
  validate(Joi.object({ planId: Joi.string().required(), preserveTopups: Joi.boolean().optional() })),
  asyncHandler(aiAddonAdminController.assignWorkspacePlan)
);
router.post(
  "/ai-addon/workspaces/:workspaceId/financial-action",
  validate(aiFinancialActionSchema),
  asyncHandler(aiAddonAdminController.issueWorkspaceFinancialAction)
);

module.exports = router;
