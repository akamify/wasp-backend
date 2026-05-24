const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { overview, templatePerformance } = require("@modules/analytics/controllers/analytics.controller");

const router = express.Router();

router.get("/overview", auth, requireWorkspace, asyncHandler(overview));
router.get("/template/:id", auth, requireWorkspace, asyncHandler(templatePerformance));

module.exports = router;


