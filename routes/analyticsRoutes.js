const express = require("express");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { asyncHandler } = require("../utils/asyncHandler");
const { overview, templatePerformance } = require("../controllers/analyticsController");

const router = express.Router();

router.get("/overview", auth, requireWorkspace, asyncHandler(overview));
router.get("/template/:id", auth, requireWorkspace, asyncHandler(templatePerformance));

module.exports = router;

