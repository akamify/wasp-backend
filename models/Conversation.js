const mongoose = require("mongoose");

const ConversationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    phone: { type: String, required: true, index: true },
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String },
    unreadCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ConversationSchema.index({ workspaceId: 1, phone: 1 }, { unique: true });

const Conversation = mongoose.model("Conversation", ConversationSchema);

module.exports = { Conversation };

