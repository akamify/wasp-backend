const mongoose = require("mongoose");

const FlowEventSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
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
      default: null,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlowSession",
      default: null,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },
    eventType: { type: String, required: true, trim: true },
    nodeId: { type: String, trim: true, default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

FlowEventSchema.index({ workspaceId: 1, sessionId: 1, createdAt: 1 });
FlowEventSchema.index({ workspaceId: 1, flowId: 1, createdAt: -1 });

const FlowEvent = mongoose.model("FlowEvent", FlowEventSchema);

module.exports = { FlowEvent };
