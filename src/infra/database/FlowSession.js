const mongoose = require("mongoose");

const FlowSessionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      required: true,
    },
    flowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Flow",
      required: true,
    },
    flowVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlowVersion",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "completed", "handover", "expired", "failed"],
      default: "active",
    },
    currentNodeId: { type: String, trim: true, default: null },
    waitingFor: {
      type: {
        type: String,
        trim: true,
        default: null,
      },
      attributeKey: { type: String, trim: true, default: null },
      nodeId: { type: String, trim: true, default: null },
    },
    context: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    fallbackCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    lockedBy: { type: String, trim: true, default: null },
    startedAt: { type: Date, required: true, default: Date.now },
    lastMessageAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

FlowSessionSchema.index({ workspaceId: 1, contactId: 1, status: 1 });
FlowSessionSchema.index({ workspaceId: 1, expiresAt: 1 });
FlowSessionSchema.index({ workspaceId: 1, flowId: 1, status: 1 });

const FlowSession = mongoose.model("FlowSession", FlowSessionSchema);

module.exports = { FlowSession };
