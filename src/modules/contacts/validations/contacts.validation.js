const Joi = require("joi");

const contactSchema = Joi.object({
  phone: Joi.string().min(8).max(30).required(),
  name: Joi.string().max(120).allow("").optional(),
  email: Joi.string().email().allow("").optional(),
  company: Joi.string().max(120).allow("").optional(),
  language: Joi.string().max(20).allow("").optional(),
  notes: Joi.string().max(5000).allow("").optional(),
  tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
});

const updateContactSchema = Joi.object({
  phone: Joi.string().min(8).max(30).optional(),
  name: Joi.string().max(120).allow("").optional(),
  email: Joi.string().email().allow("").optional(),
  company: Joi.string().max(120).allow("").optional(),
  language: Joi.string().max(20).allow("").optional(),
  notes: Joi.string().max(5000).allow("").optional(),
  tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
});

const exportContactsCsvSchema = Joi.object({
  contactIds: Joi.array().items(Joi.string().trim().min(1)).max(500).required(),
});

module.exports = {
  contactSchema,
  updateContactSchema,
  exportContactsCsvSchema,
};

