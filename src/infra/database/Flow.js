const mongoose = require("mongoose");

const FlowTriggerSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["keyword", "template_button", "ctwa", "manual", null],
      default: null,
    },
    keywords: { type: [String], default: [] },
    matchMode: {
      type: String,
      enum: ["exact", "contains", "regex"],
      default: "exact",
    },
    templateButtonPayloads: { type: [String], default: [] },
    ctwaPayloads: { type: [String], default: [] },
  },
  { _id: false }
);

const FlowDraftSchema = new mongoose.Schema(
  {
    nodes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    edges: { type: [mongoose.Schema.Types.Mixed], default: [] },
    fallbackNodeId: { type: String, trim: true, default: null },
    handoverNodeId: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const FlowRuntimeSettingsSchema = new mongoose.Schema(
  {
    sessionTimeoutMinutes: {
      type: Number,
      min: 1,
      max: 600,
      default: 5,
    },
    onSessionExpired: {
      action: {
        type: String,
        enum: ["none", "text", "template"],
        default: "none",
      },
      textMessage: {
        type: String,
        trim: true,
        default:
          "Your previous session has expired. Please send Hi to start again.",
      },
      templateName: { type: String, trim: true, default: "" },
      languageCode: { type: String, trim: true, default: "en" },
      variables: { type: [String], default: [] },
    },
    allowKeywordRestartWhenWaiting: { type: Boolean, default: true },
    maxInvalidReplies: { type: Number, min: 1, max: 10, default: 2 },
    invalidReplyMessage: {
      type: String,
      trim: true,
      default: "Please choose one of the available options.",
    },
  },
  { _id: false }
);

const FlowSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, default: "", maxlength: 2000 },
    status: {
      type: String,
      enum: ["draft", "active", "paused", "archived"],
      default: "draft",
    },
    trigger: { type: FlowTriggerSchema, default: () => ({}) },
    draft: { type: FlowDraftSchema, default: () => ({}) },
    runtimeSettings: {
      type: FlowRuntimeSettingsSchema,
      default: () => ({}),
    },
    activeVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlowVersion",
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    archivedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

FlowSchema.index({ workspaceId: 1, status: 1 });
FlowSchema.index({ workspaceId: 1, deletedAt: 1 });
FlowSchema.index({ workspaceId: 1, "trigger.type": 1 });

const Flow = mongoose.model("Flow", FlowSchema);

module.exports = {
  Flow,
  FlowTriggerSchema,
  FlowRuntimeSettingsSchema,
};
