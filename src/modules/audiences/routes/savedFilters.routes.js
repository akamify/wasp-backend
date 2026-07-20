const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const savedFiltersController = require("@modules/audiences/controllers/savedFilters.controller");
const { savedFilterSchema, savedFilterUpdateSchema } = require("@modules/audiences/validations/audiences.validation");

const router = express.Router();
const requireContactsAccess = requireBillingFeature("contactsPageAccess", {
  message: "Your current plan does not include contacts access.",
});

router.get("/", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(savedFiltersController.listSavedFilters));
router.post("/", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(savedFilterSchema), asyncHandler(savedFiltersController.createSavedFilter));
router.put("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, validate(savedFilterUpdateSchema), asyncHandler(savedFiltersController.updateSavedFilter));
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, asyncHandler(savedFiltersController.deleteSavedFilter));

module.exports = router;
