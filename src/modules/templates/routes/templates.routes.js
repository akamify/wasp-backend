const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { templatesController, templatesMediaController } = require("@modules/templates/controllers/index");
const { templatesValidation } = require("@modules/templates/validations/index");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");

const router = express.Router();
const upload = buildMemoryUpload({
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "application/pdf"],
});

router.post("/media", auth, requireWorkspace, upload.single("file"), asyncHandler(templatesMediaController.uploadTemplateMedia));
router.get("/media/handle/:handle", auth, requireWorkspace, asyncHandler(templatesMediaController.downloadTemplateMediaByHandle));
router.post("/", auth, requireWorkspace, validate(templatesValidation.templateSchema), asyncHandler(templatesController.createTemplate));
router.get("/", auth, requireWorkspace, asyncHandler(templatesController.listTemplates));
router.post("/sync-meta", auth, requireWorkspace, validate(templatesValidation.syncMetaSchema), asyncHandler(templatesController.syncMetaTemplates));
router.get("/:id", auth, requireWorkspace, asyncHandler(templatesController.getTemplate));
router.put("/:id", auth, requireWorkspace, validate(templatesValidation.templateUpdateSchema), asyncHandler(templatesController.updateTemplate));
router.delete("/:id", auth, requireWorkspace, asyncHandler(templatesController.deleteTemplate));
router.post("/:id/submit", auth, requireWorkspace, asyncHandler(templatesController.submitForApproval));
router.get("/:id/status", auth, requireWorkspace, asyncHandler(templatesController.syncStatus));

module.exports = router;

