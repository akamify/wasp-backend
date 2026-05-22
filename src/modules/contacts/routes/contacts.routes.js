const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { contactsController } = require("@modules/contacts/controllers/index");
const { contactsValidation } = require("@modules/contacts/validations/index");

const router = express.Router();

router.get("/", auth, requireWorkspace, asyncHandler(contactsController.listContacts));
router.get("/lookup/:phone", auth, requireWorkspace, asyncHandler(contactsController.lookupContactByPhone));
router.get("/:id", auth, requireWorkspace, asyncHandler(contactsController.getContact));
router.post("/", auth, requireWorkspace, validate(contactsValidation.contactSchema), asyncHandler(contactsController.createContact));
router.put(
  "/:id",
  auth,
  requireWorkspace,
  validate(contactsValidation.updateContactSchema),
  asyncHandler(contactsController.updateContact)
);
router.post(
  "/export-csv",
  auth,
  requireWorkspace,
  validate(contactsValidation.exportContactsCsvSchema),
  asyncHandler(contactsController.exportContactsCsv)
);
router.delete("/:id", auth, requireWorkspace, asyncHandler(contactsController.deleteContact));

module.exports = router;

