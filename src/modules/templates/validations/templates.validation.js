const Joi = require("joi");

const templateSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).required(),
  language: Joi.string().min(2).max(20).required(),
  category: Joi.string().valid("marketing", "utility", "authentication").required(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).required(),
  status: Joi.forbidden(),
  metaTemplateId: Joi.forbidden(),
});

const templateUpdateSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
  language: Joi.string().min(2).max(20).optional(),
  category: Joi.string().valid("marketing", "utility", "authentication").optional(),
  components: Joi.array().items(Joi.object().unknown(true)).min(1).optional(),
});

const syncMetaSchema = Joi.object({
  name: Joi.string().regex(/^[a-z0-9_]+$/).min(3).max(512).optional(),
});

module.exports = { templateSchema, templateUpdateSchema, syncMetaSchema };

