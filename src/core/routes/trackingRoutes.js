const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { redirect, redirectTrackedMessage } = require("@modules/links/controllers/link.controller");

const router = express.Router();

router.get("/r/:trackingToken", asyncHandler(redirectTrackedMessage));
router.get("/t/:code", asyncHandler(redirect));

module.exports = router;


