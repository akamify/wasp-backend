const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const audiencesController = require("@modules/audiences/controllers/audiences.controller");
const { audienceSchema, audienceUpdateSchema } = require("@modules/audiences/validations/audiences.validation");

const router = express.Router();
const requireContactsAccess = requireBillingFeature("contactsPageAccess", {
  message: "Your current plan does not include contacts access.",
});

router.get("/", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(audiencesController.listAudiences));
router.post("/", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(audienceSchema), asyncHandler(audiencesController.createAudience));
router.get("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(audiencesController.getAudience));
router.put("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, validate(audienceUpdateSchema), asyncHandler(audiencesController.updateAudience));
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, asyncHandler(audiencesController.deleteAudience));
router.get("/:id/preview", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(audiencesController.previewAudienceContacts));

module.exports = router;
