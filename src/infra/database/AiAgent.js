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
    allowedTopics: { type: [String], default: [] },
    blockedTopics: { type: [String], default: [] },
  },
  { _id: false },
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
      enum: ["openai", "gemini", "manual"],
      default: "manual",
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
