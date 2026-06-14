const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { META_MEDIA_LIMITS } = require("@shared/constants/metaMediaLimits");
const { HttpError } = require("@shared/utils/httpError");
const mediaController = require("@modules/media/controllers/mediaAsset.controller");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: META_MEDIA_LIMITS.document.maxBytes,
  allowedMimeTypes: Object.values(META_MEDIA_LIMITS).flatMap(
    (limit) => limit.allowedMimeTypes
  ),
});
const uploadSingle = upload.single("file");

function handleUpload(req, res, next) {
  uploadSingle(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return next(
        new HttpError(400, "Media file is too large", {
          code: "MEDIA_FILE_TOO_LARGE",
        })
      );
    }
    return next(error);
  });
}

router.get(
  "/",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      type: Joi.string().valid("image", "video", "audio", "document").optional(),
      mediaType: Joi.string().valid("image", "video", "audio", "document").optional(),
      search: Joi.string().trim().max(120).allow("").optional(),
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(50).default(24),
    }),
    "query"
  ),
  asyncHandler(mediaController.list)
);

router.post(
  "/upload",
  auth,
  requireWorkspace,
  handleUpload,
  validate(
    Joi.object({
      mediaType: Joi.string().valid("image", "video", "audio", "document").required(),
      displayName: Joi.string().trim().max(180).allow("").optional(),
    })
  ),
  asyncHandler(mediaController.upload)
);

router.get("/:id", auth, requireWorkspace, asyncHandler(mediaController.get));
router.patch(
  "/:id",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      displayName: Joi.string().trim().min(1).max(180).required(),
    })
  ),
  asyncHandler(mediaController.update)
);
router.delete("/:id", auth, requireWorkspace, asyncHandler(mediaController.remove));

module.exports = router;
