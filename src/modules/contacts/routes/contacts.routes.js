const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { contactsController } = require("@modules/contacts/controllers/index");
const { contactsValidation } = require("@modules/contacts/validations/index");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();
const requireContactsAccess = requireBillingFeature("contactsPageAccess", {
  message: "Your current plan does not include contacts access.",
});

router.get("/", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.listContacts));
router.get("/lookup/:phone", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.lookupContactByPhone));
router.get("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.view"), requireContactsAccess, asyncHandler(contactsController.getContact));
router.post("/", auth, requireWorkspace, requireWorkspacePermission("contacts.create"), requireContactsAccess, validate(contactsValidation.contactSchema), asyncHandler(contactsController.createContact));
router.put(
  "/:id",
  auth,
  requireWorkspace,
  requireWorkspacePermission("contacts.view"),
  requireWorkspacePermission("contacts.update"),
  requireContactsAccess,
  validate(contactsValidation.updateContactSchema),
  asyncHandler(contactsController.updateContact)
);
router.post(
  "/export-csv",
  auth,
  requireWorkspace,
  requireContactsAccess,
  validate(contactsValidation.exportContactsCsvSchema),
  asyncHandler(contactsController.exportContactsCsv)
);
router.delete("/:id", auth, requireWorkspace, requireWorkspacePermission("contacts.delete"), requireContactsAccess, asyncHandler(contactsController.deleteContact));

module.exports = router;

