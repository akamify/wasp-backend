const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { META_MEDIA_LIMITS } = require("@shared/constants/metaMediaLimits");
const mediaController = require("@modules/media/controllers/mediaAsset.controller");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: META_MEDIA_LIMITS.document.maxBytes,
  allowedMimeTypes: Object.values(META_MEDIA_LIMITS).flatMap(
    (limit) => limit.allowedMimeTypes
  ),
});

router.get(
  "/",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      type: Joi.string().valid("image", "video", "audio", "document").optional(),
    }),
    "query"
  ),
  asyncHandler(mediaController.list)
);

router.post(
  "/upload",
  auth,
  requireWorkspace,
  upload.single("file"),
  validate(
    Joi.object({
      mediaType: Joi.string().valid("image", "video", "audio", "document").required(),
    })
  ),
  asyncHandler(mediaController.upload)
);

router.delete("/:id", auth, requireWorkspace, asyncHandler(mediaController.remove));

module.exports = router;
