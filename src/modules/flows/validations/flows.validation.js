const Joi = require("joi");

const triggerSchema = Joi.object({
  type: Joi.string()
    .valid("keyword", "template_button", "ctwa", "manual")
    .allow(null)
    .optional(),
  keywords: Joi.array().items(Joi.string().max(500)).optional(),
  matchMode: Joi.string().valid("exact", "contains", "regex").optional(),
  templateButtonPayloads: Joi.array().items(Joi.string().max(1000)).optional(),
  ctwaPayloads: Joi.array().items(Joi.string().max(1000)).optional(),
})
  .allow(null)
  .optional();

const createFlowSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(2000).allow("").optional(),
});

const updateFlowMetadataSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).optional(),
  description: Joi.string().trim().max(2000).allow("").optional(),
}).min(1);

const saveDraftSchema = Joi.object({
  trigger: triggerSchema,
  nodes: Joi.array().items(Joi.object().unknown(true)).required(),
  edges: Joi.array().items(Joi.object().unknown(true)).required(),
  fallbackNodeId: Joi.string().trim().max(200).allow(null, "").optional(),
  handoverNodeId: Joi.string().trim().max(200).allow(null, "").optional(),
});

const listFlowsQuerySchema = Joi.object({
  status: Joi.string().valid("draft", "active", "paused", "archived").optional(),
  search: Joi.string().trim().max(200).allow("").optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  workspaceId: Joi.string().optional(),
});

const startFlowSchema = Joi.object({
  contactId: Joi.string().trim().required(),
  initialContext: Joi.object().unknown(true).default({}),
  force: Joi.boolean().default(false),
});

module.exports = {
  createFlowSchema,
  updateFlowMetadataSchema,
  saveDraftSchema,
  listFlowsQuerySchema,
  startFlowSchema,
};
