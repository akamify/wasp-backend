const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { listPlans } = require("@modules/billing/controllers/plan.controller");
const { getCurrentSubscription, getSubscriptionHistory } = require("@modules/billing/controllers/subscription.controller");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();

router.get("/plans", asyncHandler(listPlans));
router.get("/current", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getCurrentSubscription));
router.get("/history", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getSubscriptionHistory));

module.exports = router;
