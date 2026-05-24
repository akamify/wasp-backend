const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { listPlans } = require("@modules/billing/controllers/plan.controller");
const { getCurrentSubscription, getSubscriptionHistory } = require("@modules/billing/controllers/subscription.controller");

const router = express.Router();

router.get("/plans", asyncHandler(listPlans));
router.get("/current", auth, requireWorkspace, asyncHandler(getCurrentSubscription));
router.get("/history", auth, requireWorkspace, asyncHandler(getSubscriptionHistory));

module.exports = router;
