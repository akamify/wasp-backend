const mongoose = require("mongoose");

const AiUsageLogSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiAgent",
      required: true,
      index: true,
    },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiConversation",
      default: null,
      index: true,
    },
    executionKey: { type: String, trim: true, default: null, index: true },
    provider: { type: String, trim: true, default: "manual", index: true },
    model: { type: String, trim: true, default: "" },
    inputTokens: { type: Number, min: 0, default: 0 },
    outputTokens: { type: Number, min: 0, default: 0 },
    totalTokens: { type: Number, min: 0, default: 0 },
    creditsUsed: { type: Number, min: 0, default: 1 },
    estimatedCost: { type: Number, min: 0, default: 0 },
    latencyMs: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: ["success", "failed", "blocked"],
      default: "success",
      index: true,
    },
    action: {
      type: String,
      enum: ["reply", "handover", "blocked"],
      default: "reply",
    },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true },
);

AiUsageLogSchema.index({ workspaceId: 1, createdAt: -1 });
AiUsageLogSchema.index({ workspaceId: 1, agentId: 1, createdAt: -1 });
AiUsageLogSchema.index(
  { workspaceId: 1, executionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      executionKey: { $type: "string" },
    },
  }
);

const AiUsageLog = mongoose.model("AiUsageLog", AiUsageLogSchema);

module.exports = { AiUsageLog };
