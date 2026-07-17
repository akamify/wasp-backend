const mongoose = require("mongoose");

const AiConversationMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant", "system", "tool"],
      required: true,
    },
    text: { type: String, trim: true, maxlength: 20000, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const AiConversationSchema = new mongoose.Schema(
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
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
      index: true,
    },
    channel: {
      type: String,
      enum: ["test", "whatsapp", "api"],
      default: "test",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "handover", "closed"],
      default: "active",
      index: true,
    },
    messages: {
      type: [AiConversationMessageSchema],
      default: [],
    },
    summary: {
      type: String,
      trim: true,
      maxlength: 12000,
      default: "",
    },
    summaryUpdatedAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

AiConversationSchema.index({ workspaceId: 1, agentId: 1, channel: 1, lastMessageAt: -1 });
AiConversationSchema.index({ workspaceId: 1, contactId: 1, agentId: 1, status: 1 });

const AiConversation = mongoose.model("AiConversation", AiConversationSchema);

module.exports = { AiConversation };
