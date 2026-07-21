const express = require("express");
const mongoose = require("mongoose");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { HttpError } = require("@shared/utils/httpError");
const { contactsController, contactAttributesController, contactListsController } = require("@modules/contacts/controllers/index");
const { contactsValidation } = require("@modules/contacts/validations/index");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();
const requireContactsAccess = requireBillingFeature("contactsPageAccess", {
  message: "Your current plan does not include contacts access.",
});

function requireObjectIdParam(paramName) {
  return (req, res, next) => {
    const value = String(req.params?.[paramName] || "").trim();
    if (!mongoose.Types.ObjectId.isValid(value)) {
      return next(new HttpError(400, "Invalid identifier"));
    }
    return next();
  };
}

router.get("/", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.listContacts));
router.get("/tags", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.listContactTags));
router.get("/lists", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactListsController.listContactLists));
router.post("/lists", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(contactsValidation.contactListSchema), asyncHandler(contactListsController.createContactList));
router.get("/lists/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, requireObjectIdParam("id"), asyncHandler(contactListsController.getContactList));
router.patch("/lists/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, requireObjectIdParam("id"), validate(contactsValidation.updateContactListSchema), asyncHandler(contactListsController.updateContactList));
router.delete("/lists/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, requireObjectIdParam("id"), asyncHandler(contactListsController.deleteContactList));
router.post("/filter-preview", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, validate(contactsValidation.filterPreviewSchema), asyncHandler(contactsController.filterPreview));
router.post("/export", auth, requireWorkspace, requireContactsAccess, validate(contactsValidation.exportContactsSchema), asyncHandler(contactsController.exportContacts));
router.get("/attributes", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactAttributesController.listDefinitions));
router.post("/attributes", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(contactsValidation.attributeDefinitionCreateSchema), asyncHandler(contactAttributesController.createDefinition));
router.get("/attributes/:key", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactAttributesController.getDefinition));
router.patch("/attributes/:key", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, validate(contactsValidation.attributeDefinitionUpdateSchema), asyncHandler(contactAttributesController.updateDefinition));
router.delete("/attributes/:key", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, asyncHandler(contactAttributesController.archiveDefinition));
router.get("/lookup/:phone", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.lookupContactByPhone));
router.post(
  "/import-csv",
  auth,
  requireWorkspace,
  requireWorkspacePermission("contacts.create"),
  requireContactsAccess,
  validate(contactsValidation.importContactsCsvSchema),
  asyncHandler(contactsController.importContactsCsv)
);
router.get("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, requireObjectIdParam("id"), asyncHandler(contactsController.getContact));
router.post("/", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(contactsValidation.contactSchema), asyncHandler(contactsController.createContact));
router.put(
  "/:id",
  auth,
  requireWorkspace,
  requireWorkspacePermission("contacts.view"),
  requireWorkspacePermission("contacts.update"),
  requireContactsAccess,
  requireObjectIdParam("id"),
  validate(contactsValidation.updateContactSchema),
  asyncHandler(contactsController.updateContact)
);
router.patch("/:id/attributes", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, requireObjectIdParam("id"), validate(contactsValidation.contactAttributesSchema), asyncHandler(contactAttributesController.patchContactAttributes));
router.put("/:id/attributes", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, requireObjectIdParam("id"), validate(contactsValidation.contactAttributesSchema), asyncHandler(contactAttributesController.replaceContactAttributes));
router.delete("/:id/attributes/:key", auth, requireWorkspace, requireWorkspacePermission("contacts.update"), requireContactsAccess, requireObjectIdParam("id"), asyncHandler(contactAttributesController.deleteContactAttribute));
router.post(
  "/export-csv",
  auth,
  requireWorkspace,
  requireContactsAccess,
  validate(contactsValidation.exportContactsCsvSchema),
  asyncHandler(contactsController.exportContactsCsv)
);
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, requireObjectIdParam("id"), asyncHandler(contactsController.deleteContact));

module.exports = router;

