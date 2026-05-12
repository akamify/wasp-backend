const express = require("express");
const Joi = require("joi");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { asyncHandler } = require("../utils/asyncHandler");
const {
  createLink,
  createWhatsAppTrackedLink,
  listTrackedLinks,
  updateTrackedLink,
  deleteTrackedLink,
  getTrackedLinkAnalytics,
  qrSvg,
  qrPng,
} = require("../controllers/linkController");

const router = express.Router();

router.get("/tracked", auth, requireWorkspace, asyncHandler(listTrackedLinks));
router.post(
  "/tracked",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      message: Joi.string().min(1).max(2000).required(),
      title: Joi.string().max(120).allow("").optional(),
    })
  ),
  asyncHandler(createWhatsAppTrackedLink)
);
router.put(
  "/tracked/:id",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      message: Joi.string().min(1).max(2000).optional(),
      title: Joi.string().max(120).allow("").optional(),
    })
  ),
  asyncHandler(updateTrackedLink)
);
router.delete("/tracked/:id", auth, requireWorkspace, asyncHandler(deleteTrackedLink));
router.get("/tracked/:id/analytics", auth, requireWorkspace, asyncHandler(getTrackedLinkAnalytics));
router.get("/tracked/:id/qr.svg", auth, requireWorkspace, asyncHandler(qrSvg));
router.get("/tracked/:id/qr.png", auth, requireWorkspace, asyncHandler(qrPng));

router.post(
  "/",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      url: Joi.string().required(),
      templateId: Joi.string().optional(),
      messageId: Joi.string().optional(),
    })
  ),
  asyncHandler(createLink)
);

module.exports = router;

