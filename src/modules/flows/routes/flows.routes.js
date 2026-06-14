const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const flowsController = require("@modules/flows/controllers/flows.controller");
const flowsValidation = require("@modules/flows/validations/flows.validation");

const router = express.Router();

router.post(
  "/",
  auth,
  requireWorkspace,
  validate(flowsValidation.createFlowSchema),
  asyncHandler(flowsController.createFlow)
);
router.get(
  "/",
  auth,
  requireWorkspace,
  validate(flowsValidation.listFlowsQuerySchema, "query"),
  asyncHandler(flowsController.listFlows)
);
router.get(
  "/:flowId",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.getFlow)
);
router.patch(
  "/:flowId",
  auth,
  requireWorkspace,
  validate(flowsValidation.updateFlowMetadataSchema),
  asyncHandler(flowsController.updateFlowMetadata)
);
router.put(
  "/:flowId/draft",
  auth,
  requireWorkspace,
  validate(flowsValidation.saveDraftSchema),
  asyncHandler(flowsController.saveDraft)
);
router.post(
  "/:flowId/validate",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.validateDraft)
);
router.post(
  "/:flowId/publish",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.publishFlow)
);
router.post(
  "/:flowId/pause",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.pauseFlow)
);
router.post(
  "/:flowId/resume",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.resumeFlow)
);
router.post(
  "/:flowId/archive",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.archiveFlow)
);
router.post(
  "/:flowId/start",
  auth,
  requireWorkspace,
  validate(flowsValidation.startFlowSchema),
  asyncHandler(flowsController.startFlow)
);
router.delete(
  "/:flowId",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.softDeleteFlow)
);
router.get(
  "/:flowId/versions",
  auth,
  requireWorkspace,
  asyncHandler(flowsController.listFlowVersions)
);

module.exports = router;
