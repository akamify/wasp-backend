const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const {
  createLink,
  createWhatsAppTrackedLink,
  listTrackedLinks,
  updateTrackedLink,
  deleteTrackedLink,
  getTrackedLinkAnalytics,
  qrSvg,
  qrPng,
} = require("@modules/links/controllers/link.controller");

const router = express.Router();
const requireLinksAccess = requireBillingFeature("linksPageAccess", {
  message: "Your current plan does not include tracked links access.",
});

router.get("/tracked", auth, requireWorkspace, requireLinksAccess, asyncHandler(listTrackedLinks));
router.post(
  "/tracked",
  auth,
  requireWorkspace,
  requireLinksAccess,
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
  requireLinksAccess,
  validate(
    Joi.object({
      message: Joi.string().min(1).max(2000).optional(),
      title: Joi.string().max(120).allow("").optional(),
    })
  ),
  asyncHandler(updateTrackedLink)
);
router.delete("/tracked/:id", auth, requireWorkspace, requireLinksAccess, asyncHandler(deleteTrackedLink));
router.get("/tracked/:id/analytics", auth, requireWorkspace, requireLinksAccess, asyncHandler(getTrackedLinkAnalytics));
router.get("/tracked/:id/qr.svg", auth, requireWorkspace, requireLinksAccess, asyncHandler(qrSvg));
router.get("/tracked/:id/qr.png", auth, requireWorkspace, requireLinksAccess, asyncHandler(qrPng));

router.post(
  "/",
  auth,
  requireWorkspace,
  requireLinksAccess,
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


