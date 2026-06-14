const mongoose = require("mongoose");
const {
  FlowTriggerSchema,
  FlowRuntimeSettingsSchema,
} = require("@infra/database/Flow");

const FlowVersionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      immutable: true,
    },
    flowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Flow",
      required: true,
      immutable: true,
    },
    versionNumber: { type: Number, required: true, min: 1, immutable: true },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "inactive",
    },
    trigger: { type: FlowTriggerSchema, required: true, immutable: true },
    runtimeSettings: {
      type: FlowRuntimeSettingsSchema,
      required: true,
      immutable: true,
      default: () => ({}),
    },
    nodes: {
      type: [mongoose.Schema.Types.Mixed],
      required: true,
      immutable: true,
    },
    edges: {
      type: [mongoose.Schema.Types.Mixed],
      required: true,
      immutable: true,
    },
    fallbackNodeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },
    handoverNodeId: {
      type: String,
      trim: true,
      default: null,
      immutable: true,
    },
    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      immutable: true,
    },
    publishedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
  },
  { timestamps: true }
);

FlowVersionSchema.index(
  { workspaceId: 1, flowId: 1, versionNumber: -1 },
  { unique: true }
);
FlowVersionSchema.index({ workspaceId: 1, status: 1 });

const FlowVersion = mongoose.model("FlowVersion", FlowVersionSchema);

module.exports = { FlowVersion };
