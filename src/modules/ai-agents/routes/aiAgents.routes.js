const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { requireAiAgentAccess } = require("@modules/ai-agents/middleware/requireAiAgentAccess");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const aiAgentsController = require("@modules/ai-agents/controllers/aiAgents.controller");
const aiAgentsValidation = require("@modules/ai-agents/validations/aiAgents.validation");

const router = express.Router();
const knowledgeUpload = buildMemoryUpload({
  maxFileSizeBytes: 10 * 1024 * 1024,
  allowedMimeTypes: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "text/comma-separated-values",
    "text/plain",
  ],
});

router.use(auth, requireWorkspace);

router.get(
  "/addon",
  requireWorkspacePermission("automation.view"),
  asyncHandler(aiAgentsController.addonStatus),
);
router.post(
  "/addon/purchase",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to purchase AI Agents." }),
  requireWorkspacePermission("billing.manage"),
  asyncHandler(aiAgentsController.purchaseAddon),
);
router.get(
  "/dashboard",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("automation.view"),
  validate(aiAgentsValidation.dashboardQuerySchema, "query"),
  asyncHandler(aiAgentsController.dashboard),
);
router.get(
  "/addon/transactions",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.addonTransactionsQuerySchema, "query"),
  asyncHandler(aiAgentsController.listAddonTransactions),
);
router.get(
  "/billing/summary",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.billingAnalyticsQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingSummary),
);
router.get(
  "/billing/statements",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.billingStatementsQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingStatements),
);
router.get(
  "/billing/statements/:periodKey",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  asyncHandler(aiAgentsController.billingStatement),
);
router.get(
  "/billing/statements/:periodKey/download",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.reports"),
  asyncHandler(aiAgentsController.downloadBillingStatement),
);
router.get(
  "/billing/timeline",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.billingAnalyticsQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingTimeline),
);
router.get(
  "/billing/analytics",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.billingAnalyticsQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingAnalytics),
);
router.get(
  "/billing/usage-explorer",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  validate(aiAgentsValidation.billingUsageExplorerQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingUsageExplorer),
);
router.get(
  "/billing/budget",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.view"),
  asyncHandler(aiAgentsController.billingBudget),
);
router.put(
  "/billing/budget",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.budget"),
  validate(aiAgentsValidation.billingBudgetSchema),
  asyncHandler(aiAgentsController.updateBillingBudget),
);
router.get(
  "/billing/reports",
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess,
  requireWorkspacePermission("aiBilling.reports"),
  validate(aiAgentsValidation.billingReportQuerySchema, "query"),
  asyncHandler(aiAgentsController.billingReport),
);

router.use(
  requireBillingFeature("aiAgentsPageAccess", { message: "Upgrade plan to access AI Agents." }),
  requireAiAgentAccess
);
router.post(
  "/addon/topups",
  requireWorkspacePermission("aiBilling.manage"),
  validate(aiAgentsValidation.addonTopupSchema),
  asyncHandler(aiAgentsController.purchaseAddonTopup),
);
router.post(
  "/addon/transactions/adjust",
  requireWorkspacePermission("aiBilling.manage"),
  validate(aiAgentsValidation.addonAdjustmentSchema),
  asyncHandler(aiAgentsController.applyAddonAdjustment),
);

router.get(
  "/",
  requireWorkspacePermission("automation.view"),
  validate(aiAgentsValidation.listAiAgentsQuerySchema, "query"),
  asyncHandler(aiAgentsController.listAgents),
);
router.post(
  "/",
  requireWorkspacePermission("automation.create"),
  validate(aiAgentsValidation.createAiAgentSchema),
  asyncHandler(aiAgentsController.createAgent),
);
router.get(
  "/:agentId",
  requireWorkspacePermission("automation.view"),
  asyncHandler(aiAgentsController.getAgent),
);
router.get(
  "/:agentId/conversations",
  requireWorkspacePermission("automation.view"),
  asyncHandler(aiAgentsController.listConversations),
);
router.get(
  "/:agentId/knowledge",
  requireWorkspacePermission("automation.view"),
  asyncHandler(aiAgentsController.listKnowledge),
);
router.post(
  "/:agentId/knowledge",
  requireWorkspacePermission("automation.update"),
  validate(aiAgentsValidation.knowledgeSourceSchemaV2),
  asyncHandler(aiAgentsController.createKnowledge),
);
router.post(
  "/:agentId/knowledge/upload",
  requireWorkspacePermission("automation.update"),
  knowledgeUpload.single("file"),
  asyncHandler(aiAgentsController.uploadKnowledge),
);
router.put(
  "/:agentId/knowledge/:sourceId",
  requireWorkspacePermission("automation.update"),
  validate(aiAgentsValidation.knowledgeSourceSchemaV2),
  asyncHandler(aiAgentsController.updateKnowledge),
);
router.delete(
  "/:agentId/knowledge/:sourceId",
  requireWorkspacePermission("automation.update"),
  asyncHandler(aiAgentsController.deleteKnowledge),
);
router.post(
  "/:agentId/knowledge/:sourceId/reindex",
  requireWorkspacePermission("automation.update"),
  asyncHandler(aiAgentsController.reindexKnowledge),
);
router.post(
  "/:agentId/test-message",
  requireWorkspacePermission("automation.update"),
  validate(aiAgentsValidation.testMessageSchema),
  asyncHandler(aiAgentsController.testMessage),
);
router.delete(
  "/:agentId/test-memory",
  requireWorkspacePermission("automation.update"),
  validate(aiAgentsValidation.clearTestMemorySchema),
  asyncHandler(aiAgentsController.clearTestMemory),
);
router.patch(
  "/:agentId",
  requireWorkspacePermission("automation.update"),
  validate(aiAgentsValidation.updateAiAgentSchema),
  asyncHandler(aiAgentsController.updateAgent),
);
router.delete(
  "/:agentId",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(aiAgentsController.deleteAgent),
);

module.exports = router;
