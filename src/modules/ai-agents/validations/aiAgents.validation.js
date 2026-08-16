const Joi = require("joi");

const statusSchema = Joi.string().valid("draft", "active", "paused", "archived");
const personaSchema = Joi.string().valid("sales", "support", "booking", "faq", "custom");
const providerSchema = Joi.string().valid("gemini");

const knowledgeSourceSchema = Joi.object({
  _id: Joi.string().optional(),
  type: Joi.string().valid("text", "url", "faq", "file").default("text"),
  title: Joi.string().trim().max(160).allow("").default(""),
  content: Joi.string().trim().max(20000).allow("").default(""),
  url: Joi.string().trim().max(2048).allow("").default(""),
  metadata: Joi.object().unknown(true).default({}),
});

const assignedActionKeySchema = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z0-9][a-z0-9_-]{0,79}$/)
  .required();

function uniqueByKey(items, helpers) {
  const seen = new Set();
  for (const item of items || []) {
    const key = String(item?.key || item?.id || "").trim().toLowerCase();
    if (seen.has(key)) return helpers.error("any.invalid");
    seen.add(key);
  }
  return items;
}

const assignedFlowConfigSchema = Joi.object({
  flows: Joi.array()
    .items(
      Joi.object({
        key: assignedActionKeySchema,
        flowId: Joi.string().trim().hex().length(24).required(),
        name: Joi.string().trim().max(120).allow("").default(""),
        title: Joi.string().trim().max(20).allow("").default(""),
        purpose: Joi.string().trim().max(300).allow("").default(""),
        whenToUse: Joi.array().items(Joi.string().trim().max(160)).max(8).default([]),
      }).unknown(false)
    )
    .max(50)
    .custom(uniqueByKey, "unique assigned flow keys")
    .default([]),
}).unknown(false);

const assignedTemplateConfigSchema = Joi.object({
  templates: Joi.array()
    .items(
      Joi.object({
        key: assignedActionKeySchema,
        templateId: Joi.string().trim().hex().length(24).required(),
        name: Joi.string().trim().max(512).allow("").default(""),
        languageCode: Joi.string().trim().max(32).allow("").default(""),
        title: Joi.string().trim().max(40).allow("").default(""),
        purpose: Joi.string().trim().max(300).allow("").default(""),
        allowedVariables: Joi.array().items(Joi.string().trim().max(80)).max(30).default([]),
      }).unknown(false)
    )
    .max(50)
    .custom(uniqueByKey, "unique assigned template keys")
    .default([]),
}).unknown(false);

const sendListConfigSchema = Joi.object({
  defaultBody: Joi.string().trim().max(1024).allow("").default(""),
  defaultTitle: Joi.string().trim().max(60).allow("").default(""),
  defaultButtonText: Joi.string().trim().max(20).allow("").default("View options"),
}).unknown(false);

const sendButtonsConfigSchema = Joi.object({
  defaultBody: Joi.string().trim().max(1024).allow("").default(""),
  buttons: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().trim().min(1).max(256).required(),
        title: Joi.string().trim().min(1).max(20).required(),
        description: Joi.string().trim().max(120).allow("").optional(),
        flowId: Joi.string().trim().hex().length(24).optional(),
        key: Joi.string().trim().lowercase().pattern(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
        kind: Joi.string().valid("flow", "template", "handover").optional(),
      }).unknown(false)
    )
    .max(30)
    .custom((buttons, helpers) => {
      const seen = new Set();
      for (const button of buttons || []) {
        const id = String(button?.id || "").trim();
        if (seen.has(id)) return helpers.error("any.invalid");
        seen.add(id);
      }
      return buttons;
    }, "unique send_buttons ids")
    .default([]),
}).unknown(false);

const toolSchema = Joi.object({
  type: Joi.string()
    .valid(
      "crm_lookup",
      "contact_update",
      "set_tag",
      "set_attribute",
      "api_request",
      "handover",
      "send_buttons",
      "start_flow",
      "send_list",
      "send_template"
    )
    .required(),
  enabled: Joi.boolean().default(true),
  config: Joi.alternatives().conditional("type", {
    switch: [
      { is: "send_buttons", then: sendButtonsConfigSchema.default({}) },
      { is: "start_flow", then: assignedFlowConfigSchema.default({}) },
      { is: "send_list", then: sendListConfigSchema.default({}) },
      { is: "send_template", then: assignedTemplateConfigSchema.default({}) },
    ],
    otherwise: Joi.object().unknown(true).default({}),
  }),
}).messages({
  "any.invalid": "AI tool semantic keys must be unique",
});

const guardrailsSchema = Joi.object({
  fallbackMessage: Joi.string().trim().max(1000).allow("").optional(),
  handoverOnLowConfidence: Joi.boolean().optional(),
  maxMessagesPerSession: Joi.number().integer().min(1).max(500).optional(),
  confidenceThreshold: Joi.number().min(0.1).max(0.95).optional(),
  allowedTopics: Joi.array().items(Joi.string().trim().max(120)).optional(),
  blockedTopics: Joi.array().items(Joi.string().trim().max(120)).optional(),
}).optional();

const runtimeControlsSchema = Joi.object({
  businessHours: Joi.object({
    enabled: Joi.boolean().optional(),
    timezone: Joi.string().trim().max(80).allow("").optional(),
    days: Joi.array().items(Joi.string().valid("sun", "mon", "tue", "wed", "thu", "fri", "sat")).max(7).optional(),
    startTime: Joi.string().pattern(/^\d{2}:\d{2}$/).optional(),
    endTime: Joi.string().pattern(/^\d{2}:\d{2}$/).optional(),
    afterHoursAction: Joi.string().valid("reply_and_handover", "handover_only", "pause").optional(),
  }).optional(),
  escalationRules: Joi.object({
    enabled: Joi.boolean().optional(),
    keywords: Joi.array().items(Joi.string().trim().max(120)).optional(),
    slaMinutes: Joi.number().integer().min(1).max(1440).optional(),
    action: Joi.string().valid("handover", "pause").optional(),
  }).optional(),
  conversationSla: Joi.object({
    enabled: Joi.boolean().optional(),
    firstResponseMinutes: Joi.number().integer().min(1).max(1440).optional(),
  }).optional(),
  fallbackTemplates: Joi.object({
    afterHours: Joi.string().trim().max(2000).allow("").optional(),
    escalation: Joi.string().trim().max(2000).allow("").optional(),
    noAnswer: Joi.string().trim().max(2000).allow("").optional(),
  }).optional(),
  routing: Joi.object({
    keywords: Joi.array().items(Joi.string().trim().max(120)).optional(),
    priority: Joi.number().integer().min(0).max(1000).optional(),
    channels: Joi.array().items(Joi.string().valid("whatsapp", "test", "api")).max(3).optional(),
  }).optional(),
}).optional();

const metadataSchema = Joi.object({
  managedFileSearch: Joi.object({
    enabled: Joi.boolean().optional(),
  }).optional(),
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
  runtimeControls: runtimeControlsSchema,
  metadata: metadataSchema,
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

const addonTransactionsQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).optional(),
  cursor: Joi.string().trim().allow("").optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  type: Joi.string().trim().allow("").optional(),
  entryType: Joi.string().trim().allow("").optional(),
  source: Joi.string().trim().allow("").optional(),
  search: Joi.string().trim().max(200).allow("").optional(),
  agentId: Joi.string().trim().allow("").optional(),
  conversationId: Joi.string().trim().allow("").optional(),
});

const dashboardQuerySchema = Joi.object({
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  agentId: Joi.string().trim().allow("").optional(),
  channel: Joi.string().valid("all", "test", "whatsapp", "api").optional(),
});

const addonTopupSchema = Joi.object({
  packId: Joi.string().trim().min(1).max(120).required(),
});

const addonAdjustmentSchema = Joi.object({
  type: Joi.string().valid("refund", "adjustment").required(),
  credits: Joi.number().min(-100000).max(100000).invalid(0).required(),
  reason: Joi.string().trim().max(500).allow("").optional(),
  reference: Joi.string().trim().max(160).allow("").optional(),
});

const billingStatementsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(24).optional(),
  period: Joi.string().pattern(/^\d{4}-\d{2}$/).allow("").optional(),
});

const billingAnalyticsQuerySchema = Joi.object({
  preset: Joi.string().valid("today", "yesterday", "last_7_days", "last_30_days", "custom").allow("").optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  agentId: Joi.string().trim().allow("").optional(),
  channel: Joi.string().valid("all", "test", "whatsapp", "api").allow("").optional(),
});

const billingUsageExplorerQuerySchema = Joi.object({
  preset: Joi.string().valid("today", "yesterday", "last_7_days", "last_30_days", "custom").allow("").optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  agentId: Joi.string().trim().allow("").optional(),
  conversationId: Joi.string().trim().allow("").optional(),
  executionId: Joi.string().trim().allow("").optional(),
  runtimeStatus: Joi.string().trim().allow("").optional(),
  conversationStatus: Joi.string().trim().allow("").optional(),
  model: Joi.string().trim().allow("").optional(),
  channel: Joi.string().valid("all", "test", "whatsapp", "api").allow("").optional(),
  creditMin: Joi.number().min(0).optional(),
  creditMax: Joi.number().min(0).optional(),
  search: Joi.string().trim().max(200).allow("").optional(),
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
});

const billingBudgetSchema = Joi.object({
  monthlyCreditBudget: Joi.number().min(0).required(),
  monthlyCreditWarning: Joi.number().min(0).required(),
  lowCreditWarning: Joi.number().min(0).required(),
  nearExhaustionWarning: Joi.number().min(0).required(),
  notificationsEnabled: Joi.boolean().optional(),
});

const billingReportQuerySchema = Joi.object({
  reportType: Joi.string()
    .valid("daily_ai_usage", "monthly_ai_billing", "top_consuming_agents", "refund_summary", "adjustment_summary", "revenue_summary")
    .required(),
  format: Joi.string().valid("json", "csv").allow("").optional(),
  preset: Joi.string().valid("today", "yesterday", "last_7_days", "last_30_days", "custom").allow("").optional(),
  dateFrom: Joi.date().iso().optional(),
  dateTo: Joi.date().iso().optional(),
  period: Joi.string().pattern(/^\d{4}-\d{2}$/).allow("").optional(),
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
  addonTransactionsQuerySchema,
  dashboardQuerySchema,
  addonTopupSchema,
  addonAdjustmentSchema,
  billingStatementsQuerySchema,
  billingAnalyticsQuerySchema,
  billingUsageExplorerQuerySchema,
  billingBudgetSchema,
  billingReportQuerySchema,
};
