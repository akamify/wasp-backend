const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const {
  overview,
  templatePerformance,
  campaignPerformance,
  customerAnalytics,
  agentAnalytics,
} = require("@modules/analytics/controllers/analytics.controller");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();

router.get("/overview", auth, requireWorkspace, requireWorkspacePermission("analytics.view"), asyncHandler(overview));
router.get("/campaign/:id", auth, requireWorkspace, requireWorkspacePermission("analytics.view"), asyncHandler(campaignPerformance));
router.get("/template/:id", auth, requireWorkspace, requireWorkspacePermission("analytics.view"), asyncHandler(templatePerformance));
router.get("/customer/:id", auth, requireWorkspace, requireWorkspacePermission("analytics.view"), asyncHandler(customerAnalytics));
router.get("/agents", auth, requireWorkspace, requireWorkspacePermission("analytics.view"), asyncHandler(agentAnalytics));

module.exports = router;


