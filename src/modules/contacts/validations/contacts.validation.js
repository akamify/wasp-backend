const Joi = require("joi");

const contactSchema = Joi.object({
  phone: Joi.string().min(8).max(30).required(),
  name: Joi.string().max(120).allow("").optional(),
  email: Joi.string().email().allow("").optional(),
  company: Joi.string().max(120).allow("").optional(),
  language: Joi.string().max(20).allow("").optional(),
  notes: Joi.string().max(5000).allow("").optional(),
  tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
  attributes: Joi.object()
    .pattern(
      Joi.string().trim().min(1).max(50),
      Joi.alternatives().try(Joi.string().max(200), Joi.number(), Joi.boolean(), Joi.valid(null))
    )
    .max(30)
    .optional(),
});

const updateContactSchema = Joi.object({
  phone: Joi.string().min(8).max(30).optional(),
  name: Joi.string().max(120).allow("").optional(),
  email: Joi.string().email().allow("").optional(),
  company: Joi.string().max(120).allow("").optional(),
  language: Joi.string().max(20).allow("").optional(),
  notes: Joi.string().max(5000).allow("").optional(),
  tags: Joi.array().items(Joi.string().max(40)).max(25).optional(),
  attributes: Joi.object()
    .pattern(
      Joi.string().trim().min(1).max(50),
      Joi.alternatives().try(Joi.string().max(200), Joi.number(), Joi.boolean(), Joi.valid(null))
    )
    .max(30)
    .optional(),
});

const exportContactsCsvSchema = Joi.object({
  contactIds: Joi.array().items(Joi.string().trim().min(1)).max(500).required(),
});

const attributeDefinitionCreateSchema = Joi.object({
  key: Joi.string().trim().max(50).required(),
  label: Joi.string().trim().max(80).required(),
  type: Joi.string().valid("text", "number", "boolean", "date", "url").default("text"),
  description: Joi.string().allow("").max(300).optional(),
  defaultValue: Joi.any().optional(),
  required: Joi.boolean().optional(),
  visible: Joi.boolean().optional(),
  editable: Joi.boolean().optional(),
});

const attributeDefinitionUpdateSchema = Joi.object({
  label: Joi.string().trim().max(80).optional(),
  type: Joi.string().valid("text", "number", "boolean", "date", "url").optional(),
  description: Joi.string().allow("").max(300).optional(),
  defaultValue: Joi.any().optional(),
  required: Joi.boolean().optional(),
  visible: Joi.boolean().optional(),
  editable: Joi.boolean().optional(),
  active: Joi.boolean().optional(),
}).min(1);

const contactAttributesSchema = Joi.object({
  attributes: Joi.object().max(50).required(),
});

module.exports = {
  contactSchema,
  updateContactSchema,
  exportContactsCsvSchema,
  attributeDefinitionCreateSchema,
  attributeDefinitionUpdateSchema,
  contactAttributesSchema,
};

