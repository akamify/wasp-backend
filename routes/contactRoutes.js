const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const {
  listContacts,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
} = require("../controllers/contactController");

const router = express.Router();

const contactSchema = Joi.object({
  phone: Joi.string().min(8).max(30).required(),
  name: Joi.string().max(120).allow("").optional(),
  email: Joi.string().email().allow("").optional(),
  company: Joi.string().max(120).allow("").optional(),
  language: Joi.string().max(20).allow("").optional(),
  notes: Joi.string().max(5000).allow("").optional(),
  tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
});

router.get("/", auth, requireWorkspace, asyncHandler(listContacts));
router.get("/lookup/:phone", auth, requireWorkspace, asyncHandler(lookupContactByPhone));
router.get("/:id", auth, requireWorkspace, asyncHandler(getContact));
router.post("/", auth, requireWorkspace, validate(contactSchema), asyncHandler(createContact));
router.put(
  "/:id",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      phone: Joi.string().min(8).max(30).optional(),
      name: Joi.string().max(120).allow("").optional(),
      email: Joi.string().email().allow("").optional(),
      company: Joi.string().max(120).allow("").optional(),
      language: Joi.string().max(20).allow("").optional(),
      notes: Joi.string().max(5000).allow("").optional(),
      tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
    })
  ),
  asyncHandler(updateContact)
);
router.delete("/:id", auth, requireWorkspace, asyncHandler(deleteContact));

module.exports = router;
