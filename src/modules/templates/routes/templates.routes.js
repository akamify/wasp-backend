const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { templatesController, templatesMediaController } = require("@modules/templates/controllers/index");
const { templatesValidation } = require("@modules/templates/validations/index");
const { buildMemoryUpload } = require("@shared/utils/multerUpload");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();
const libraryTrackSchema = Joi.object({
  eventType: Joi.string().valid("preview", "use", "copy", "download").required(),
});
const requireTemplatesAccess = requireBillingFeature("templatesPageAccess", {
  message: "Your current plan does not include templates access.",
});
const upload = buildMemoryUpload({
  maxFileSizeBytes: 20 * 1024 * 1024,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "video/mp4", "application/pdf"],
});

router.post("/media", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, upload.single("file"), asyncHandler(templatesMediaController.uploadTemplateMedia));
router.get("/media/handle/:handle", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesMediaController.downloadTemplateMediaByHandle));
router.post("/", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, validate(templatesValidation.templateSchema), asyncHandler(templatesController.createTemplate));
router.post("/drafts", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, validate(templatesValidation.templateDraftSchema), asyncHandler(templatesController.createDraftTemplate));
router.get("/", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.listTemplates));
router.get("/library", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.listLibraryTemplates));
router.get("/library/analytics", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.getLibraryAnalytics));
router.get("/library/packs", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.listLibraryTemplatePacks));
router.post("/library/:id/favorite", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.favoriteLibraryTemplate));
router.delete("/library/:id/favorite", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.unfavoriteLibraryTemplate));
router.post("/library/:id/track", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, validate(libraryTrackSchema), asyncHandler(templatesController.trackLibraryTemplateEvent));
router.post("/library/packs/:packKey/install", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, asyncHandler(templatesController.installLibraryTemplatePack));
router.get("/approved", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.listApprovedTemplates));
router.post("/sync-meta", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, validate(templatesValidation.syncMetaSchema), asyncHandler(templatesController.syncMetaTemplates));
router.get("/:id/history", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.listTemplateHistory));
router.patch("/drafts/:id", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, validate(templatesValidation.templateDraftUpdateSchema), asyncHandler(templatesController.updateDraftTemplate));
router.get("/:id", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.getTemplate));
router.put("/:id", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, validate(templatesValidation.templateUpdateSchema), asyncHandler(templatesController.updateTemplate));
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("templates.delete"), requireTemplatesAccess, asyncHandler(templatesController.deleteTemplate));
router.post("/:id/submit", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, asyncHandler(templatesController.submitForApproval));
router.post("/:id/duplicate", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, asyncHandler(templatesController.duplicateTemplate));
router.post("/:id/restore/:versionId", auth, requireWorkspace, requireWorkspacePermission("templates.create"), requireTemplatesAccess, asyncHandler(templatesController.restoreTemplateVersion));
router.get("/:id/status", auth, requireWorkspace, requireWorkspacePermission("templates.view"), requireTemplatesAccess, asyncHandler(templatesController.syncStatus));

module.exports = router;

