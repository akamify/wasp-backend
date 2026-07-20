const Joi = require("joi");

const filterConditionSchema = Joi.object({
  kind: Joi.string().valid("condition").default("condition"),
  field: Joi.string().trim().min(1).max(120).required(),
  fieldType: Joi.string().trim().valid("text", "number", "date", "boolean", "multi_select").optional(),
  operator: Joi.string().trim().min(1).max(40).required(),
  value: Joi.any().optional(),
  secondaryValue: Joi.any().optional(),
});

const filterTreeSchema = Joi.object({
  kind: Joi.string().valid("group").default("group"),
  operator: Joi.string().valid("and", "or").default("and"),
  conditions: Joi.array().items(Joi.object().unknown(true)).max(100).default([]),
});

const audienceSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  description: Joi.string().trim().allow("").max(500).optional(),
  type: Joi.string().valid("dynamic", "static").required(),
  filterTree: filterTreeSchema.optional().allow(null),
  contactIds: Joi.array().items(Joi.string().trim().min(1)).max(10000).optional(),
}).custom((value, helpers) => {
  if (value.type === "dynamic" && !value.filterTree) return helpers.error("any.invalid", { message: "Dynamic audiences require filterTree" });
  if (value.type === "static" && (!Array.isArray(value.contactIds) || !value.contactIds.length)) return helpers.error("any.invalid", { message: "Static audiences require contactIds" });
  return value;
});

const audienceUpdateSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).optional(),
  description: Joi.string().trim().allow("").max(500).optional(),
  type: Joi.string().valid("dynamic", "static").optional(),
  filterTree: filterTreeSchema.optional().allow(null),
  contactIds: Joi.array().items(Joi.string().trim().min(1)).max(10000).optional(),
}).min(1);

const savedFilterSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  description: Joi.string().trim().allow("").max(500).optional(),
  filterTree: filterTreeSchema.required(),
});

const savedFilterUpdateSchema = Joi.object({
  name: Joi.string().trim().min(2).max(120).optional(),
  description: Joi.string().trim().allow("").max(500).optional(),
  filterTree: filterTreeSchema.optional(),
}).min(1);

module.exports = {
  filterTreeSchema,
  audienceSchema,
  audienceUpdateSchema,
  savedFilterSchema,
  savedFilterUpdateSchema,
};
