const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { saveMetaCredentials } = require("../controllers/metaCredentialsController");
const { metaStatus } = require("../controllers/metaStatusController");
const { metaSubscriptionHealth } = require("../controllers/metaSubscriptionHealthController");
const { updateBusinessProfile, uploadProfilePicture } = require("../controllers/metaProfileController");
const { listFlows, createFlow } = require("../controllers/metaFlowsController");
const { buildMemoryUpload } = require("../utils/multerUpload");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
});

router.get("/status", auth, requireWorkspace, asyncHandler(metaStatus));
router.get("/subscription-health", auth, requireWorkspace, asyncHandler(metaSubscriptionHealth));

router.post(
  "/save",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      accessToken: Joi.string().min(10).required(),
      phoneNumberId: Joi.string().min(3).required(),
      wabaId: Joi.string().min(3).required(),
      graphApiVersion: Joi.string().pattern(/^v\d+\.\d+$/).optional(),
      override: Joi.boolean().optional(),
      overrideReason: Joi.string().trim().max(400).allow("", null).optional(),
    })
  ),
  asyncHandler(saveMetaCredentials)
);

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

router.get("/flows", auth, requireWorkspace, asyncHandler(listFlows));
router.post(
  "/flows",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      name: Joi.string().trim().min(2).max(128).required(),
      categories: Joi.array().items(Joi.string().max(64)).min(1).max(5).optional(),
    })
  ),
  asyncHandler(createFlow)
);

module.exports = router;
