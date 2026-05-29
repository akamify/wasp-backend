const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { validate } = require("@core/middleware/validate");
const { metaStatus } = require("@modules/meta/controllers/metaStatus.controller");
const { metaSubscriptionHealth } = require("@modules/meta/controllers/metaSubscriptionHealth.controller");
const { updateBusinessProfile, uploadProfilePicture } = require("@modules/meta/controllers/metaProfile.controller");
const { listFlows, createFlow, uploadFlowJson, publishFlow } = require("@modules/meta/controllers/metaFlows.controller");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const rateLimiters = require("@core/middleware/rateLimiters");

const router = express.Router();
const requireFlowsAccess = requireBillingFeature("flowsPageAccess", {
  message: "Your current plan does not include flows access.",
});
const upload = buildMemoryUpload({
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
});

router.get("/status", auth, requireWorkspace, asyncHandler(metaStatus));
router.get("/subscription-health", auth, requireWorkspace, asyncHandler(metaSubscriptionHealth));

router.put(
  "/profile",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      about: Joi.string().max(139).allow("", null).optional(),
      address: Joi.string().max(256).allow("", null).optional(),
      description: Joi.string().max(512).allow("", null).optional(),
      email: Joi.string().email().allow("", null).optional(),
      websites: Joi.array().items(Joi.string().max(2048)).max(2).optional(),
      vertical: Joi.string().max(64).allow("", null).optional(),
      profilePictureHandle: Joi.string().max(512).allow("", null).optional(),
    })
  ),
  asyncHandler(updateBusinessProfile)
);

router.post(
  "/profile-picture",
  auth,
  requireWorkspace,
  upload.single("file"),
  asyncHandler(uploadProfilePicture)
);

router.get("/flows", auth, requireWorkspace, requireFlowsAccess, rateLimiters.metaFlowOps, asyncHandler(listFlows));
router.post(
  "/flows",
  auth,
  requireWorkspace,
  requireFlowsAccess,
  rateLimiters.metaFlowOps,
  validate(
    Joi.object({
      name: Joi.string().trim().min(2).max(128).required(),
      categories: Joi.array().items(Joi.string().max(64)).min(1).max(5).optional(),
    })
  ),
  asyncHandler(createFlow)
);
router.post(
  "/flows/:flowId/assets",
  auth,
  requireWorkspace,
  requireFlowsAccess,
  rateLimiters.metaFlowOps,
  validate(
    Joi.object({
      flowJson: Joi.object().required(),
    })
  ),
  asyncHandler(uploadFlowJson)
);
router.post(
  "/flows/:flowId/publish",
  auth,
  requireWorkspace,
  requireFlowsAccess,
  rateLimiters.metaFlowOps,
  asyncHandler(publishFlow)
);

module.exports = router;

