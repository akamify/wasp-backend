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
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");

const router = express.Router();
const requireDashboardAccess = requireBillingFeature("dashboardPageAccess", {
  message: "Your current plan does not include dashboard access.",
});

router.get("/overview", auth, requireWorkspace, requireDashboardAccess, requireWorkspacePermission("analytics.view"), asyncHandler(overview));
router.get("/campaign/:id", auth, requireWorkspace, requireDashboardAccess, requireWorkspacePermission("analytics.view"), asyncHandler(campaignPerformance));
router.get("/template/:id", auth, requireWorkspace, requireDashboardAccess, requireWorkspacePermission("analytics.view"), asyncHandler(templatePerformance));
router.get("/customer/:id", auth, requireWorkspace, requireDashboardAccess, requireWorkspacePermission("analytics.view"), asyncHandler(customerAnalytics));
router.get("/agents", auth, requireWorkspace, requireDashboardAccess, requireWorkspacePermission("analytics.view"), asyncHandler(agentAnalytics));

module.exports = router;


