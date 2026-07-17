const Joi = require("joi");

const statusSchema = Joi.string().valid("draft", "active", "paused", "archived");
const personaSchema = Joi.string().valid("sales", "support", "booking", "faq", "custom");
const providerSchema = Joi.string().valid("openai", "gemini", "manual");

const knowledgeSourceSchema = Joi.object({
  _id: Joi.string().optional(),
  type: Joi.string().valid("text", "url", "faq", "file").default("text"),
  title: Joi.string().trim().max(160).allow("").default(""),
  content: Joi.string().trim().max(20000).allow("").default(""),
  url: Joi.string().trim().max(2048).allow("").default(""),
  metadata: Joi.object().unknown(true).default({}),
});

const toolSchema = Joi.object({
  type: Joi.string()
    .valid("crm_lookup", "contact_update", "set_tag", "set_attribute", "api_request", "handover")
    .required(),
  enabled: Joi.boolean().default(true),
  config: Joi.object().unknown(true).default({}),
});

const guardrailsSchema = Joi.object({
  fallbackMessage: Joi.string().trim().max(1000).allow("").optional(),
  handoverOnLowConfidence: Joi.boolean().optional(),
  maxMessagesPerSession: Joi.number().integer().min(1).max(500).optional(),
  allowedTopics: Joi.array().items(Joi.string().trim().max(120)).optional(),
  blockedTopics: Joi.array().items(Joi.string().trim().max(120)).optional(),
}).optional();

const createAiAgentSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  slug: Joi.string().trim().max(140).allow("").optional(),
  description: Joi.string().trim().max(1000).allow("").optional(),
  status: statusSchema.optional(),
  persona: personaSchema.optional(),
  modelProvider: providerSchema.optional(),
  modelName: Joi.string().trim().max(120).allow("").optional(),
  systemPrompt: Joi.string().trim().max(12000).allow("").optional(),
  language: Joi.string().trim().max(32).allow("").optional(),
  temperature: Joi.number().min(0).max(1).optional(),
  knowledgeSources: Joi.array().items(knowledgeSourceSchema).max(25).optional(),
  tools: Joi.array().items(toolSchema).max(20).optional(),
  guardrails: guardrailsSchema,
});

const updateAiAgentSchema = createAiAgentSchema.fork(["name"], (schema) => schema.optional()).min(1);

const listAiAgentsQuerySchema = Joi.object({
  status: statusSchema.allow("").optional(),
  search: Joi.string().trim().max(200).allow("").optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

const testMessageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(4000).required(),
  contactId: Joi.string().trim().allow("", null).optional(),
});

const clearTestMemorySchema = Joi.object({
  contactId: Joi.string().trim().allow("", null).optional(),
});

const knowledgeSourceSchemaV2 = Joi.object({
  type: Joi.string().valid("faq", "text", "url", "pdf", "docx", "csv", "txt").required(),
  title: Joi.string().trim().max(200).allow("").optional(),
  content: Joi.string().trim().max(50000).allow("").optional(),
  sourceUrl: Joi.string().trim().max(2048).allow("").optional(),
  url: Joi.string().trim().max(2048).allow("").optional(),
  question: Joi.string().trim().max(5000).allow("").optional(),
  answer: Joi.string().trim().max(30000).allow("").optional(),
  metadata: Joi.object().unknown(true).optional(),
});

module.exports = {
  createAiAgentSchema,
  updateAiAgentSchema,
  listAiAgentsQuerySchema,
  testMessageSchema,
  clearTestMemorySchema,
  knowledgeSourceSchemaV2,
};
