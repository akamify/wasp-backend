const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const flowsController = require("@modules/flows/controllers/flows.controller");
const flowsValidation = require("@modules/flows/validations/flows.validation");

const router = express.Router();
const requireAutomationAccess = requireBillingFeature("automationPageAccess", {
  message: "Your current plan does not include automation access.",
});

router.use(auth, requireWorkspace, requireAutomationAccess);

router.post(
  "/",
  requireWorkspacePermission("automation.create"),
  validate(flowsValidation.createFlowSchema),
  asyncHandler(flowsController.createFlow)
);
router.get(
  "/",
  requireWorkspacePermission("automation.view"),
  validate(flowsValidation.listFlowsQuerySchema, "query"),
  asyncHandler(flowsController.listFlows)
);
router.post(
  "/test-api-request",
  requireWorkspacePermission("automation.update"),
  validate(flowsValidation.testApiRequestSchema),
  asyncHandler(flowsController.testApiRequest)
);
router.post(
  "/test-media-node",
  requireWorkspacePermission("automation.update"),
  validate(flowsValidation.testMediaNodeSchema),
  asyncHandler(flowsController.testMediaNode)
);
router.get(
  "/:flowId",
  requireWorkspacePermission("automation.view"),
  asyncHandler(flowsController.getFlow)
);
router.patch(
  "/:flowId",
  requireWorkspacePermission("automation.update"),
  validate(flowsValidation.updateFlowMetadataSchema),
  asyncHandler(flowsController.updateFlowMetadata)
);
router.put(
  "/:flowId/draft",
  requireWorkspacePermission("automation.update"),
  validate(flowsValidation.saveDraftSchema),
  asyncHandler(flowsController.saveDraft)
);
router.post(
  "/:flowId/validate",
  requireWorkspacePermission("automation.update"),
  asyncHandler(flowsController.validateDraft)
);
router.post(
  "/:flowId/publish",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(flowsController.publishFlow)
);
router.post(
  "/:flowId/pause",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(flowsController.pauseFlow)
);
router.post(
  "/:flowId/resume",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(flowsController.resumeFlow)
);
router.post(
  "/:flowId/archive",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(flowsController.archiveFlow)
);
router.post(
  "/:flowId/start",
  requireWorkspacePermission("automation.manage"),
  validate(flowsValidation.startFlowSchema),
  asyncHandler(flowsController.startFlow)
);
router.delete(
  "/:flowId",
  requireWorkspacePermission("automation.manage"),
  asyncHandler(flowsController.softDeleteFlow)
);
router.get(
  "/:flowId/versions",
  requireWorkspacePermission("automation.view"),
  asyncHandler(flowsController.listFlowVersions)
);

module.exports = router;
