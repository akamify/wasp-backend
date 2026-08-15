const mongoose = require("mongoose");

const AiAgentKnowledgeSourceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["text", "url", "faq", "file"],
      default: "text",
    },
    title: { type: String, trim: true, maxlength: 160, default: "" },
    content: { type: String, trim: true, maxlength: 20000, default: "" },
    url: { type: String, trim: true, maxlength: 2048, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: true },
);

const AiAgentToolSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["crm_lookup", "contact_update", "set_tag", "set_attribute", "api_request", "handover"],
      required: true,
    },
    enabled: { type: Boolean, default: true },
    config: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const AiAgentGuardrailsSchema = new mongoose.Schema(
  {
    fallbackMessage: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "I am not fully sure about that. Let me connect you with our team.",
    },
    handoverOnLowConfidence: { type: Boolean, default: true },
    maxMessagesPerSession: { type: Number, min: 1, max: 500, default: 50 },
    confidenceThreshold: { type: Number, min: 0.1, max: 0.95, default: 0.55 },
    allowedTopics: { type: [String], default: [] },
    blockedTopics: { type: [String], default: [] },
  },
  { _id: false },
);

const AiAgentRuntimeControlsSchema = new mongoose.Schema(
  {
    businessHours: {
      enabled: { type: Boolean, default: false },
      timezone: { type: String, trim: true, maxlength: 80, default: "Asia/Calcutta" },
      days: {
        type: [String],
        default: ["mon", "tue", "wed", "thu", "fri", "sat"],
      },
      startTime: { type: String, trim: true, maxlength: 5, default: "09:00" },
      endTime: { type: String, trim: true, maxlength: 5, default: "18:00" },
      afterHoursAction: {
        type: String,
        enum: ["reply_and_handover", "handover_only", "pause"],
        default: "reply_and_handover",
      },
    },
    escalationRules: {
      enabled: { type: Boolean, default: false },
      keywords: { type: [String], default: [] },
      slaMinutes: { type: Number, min: 1, max: 1440, default: 30 },
      action: {
        type: String,
        enum: ["handover", "pause"],
        default: "handover",
      },
    },
    conversationSla: {
      enabled: { type: Boolean, default: false },
      firstResponseMinutes: { type: Number, min: 1, max: 1440, default: 15 },
    },
    fallbackTemplates: {
      afterHours: { type: String, trim: true, maxlength: 2000, default: "" },
      escalation: { type: String, trim: true, maxlength: 2000, default: "" },
      noAnswer: { type: String, trim: true, maxlength: 2000, default: "" },
    },
    routing: {
      keywords: { type: [String], default: [] },
      priority: { type: Number, min: 0, max: 1000, default: 100 },
      channels: {
        type: [String],
        default: ["whatsapp", "test", "api"],
      },
    },
  },
  { _id: false }
);

const AiAgentVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, min: 1, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    changedAt: { type: Date, default: Date.now },
    reason: { type: String, trim: true, maxlength: 500, default: "" },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: true }
);

const AiAgentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "archived"],
      default: "draft",
      index: true,
    },
    persona: {
      type: String,
      enum: ["sales", "support", "booking", "faq", "custom"],
      default: "custom",
    },
    modelProvider: {
      type: String,
      enum: ["gemini"],
      default: "gemini",
    },
    modelName: { type: String, trim: true, maxlength: 120, default: "" },
    systemPrompt: { type: String, trim: true, maxlength: 12000, default: "" },
    language: { type: String, trim: true, maxlength: 32, default: "auto" },
    temperature: { type: Number, min: 0, max: 1, default: 0.3 },
    knowledgeSources: {
      type: [AiAgentKnowledgeSourceSchema],
      default: [],
    },
    tools: {
      type: [AiAgentToolSchema],
      default: [],
    },
    guardrails: {
      type: AiAgentGuardrailsSchema,
      default: () => ({}),
    },
    runtimeControls: {
      type: AiAgentRuntimeControlsSchema,
      default: () => ({}),
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    version: { type: Number, min: 1, default: 1 },
    versionHistory: {
      type: [AiAgentVersionSchema],
      default: [],
    },
    stats: {
      conversations: { type: Number, default: 0, min: 0 },
      messages: { type: Number, default: 0, min: 0 },
      handovers: { type: Number, default: 0, min: 0 },
      lastUsedAt: { type: Date, default: null },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

AiAgentSchema.index(
  { workspaceId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
AiAgentSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });

const AiAgent = mongoose.model("AiAgent", AiAgentSchema);

module.exports = { AiAgent };
