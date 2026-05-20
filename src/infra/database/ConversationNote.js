const mongoose = require("mongoose");

const ConversationNoteSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    phone: { type: String, required: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    createdBy: { type: mongoose.Schema.Types.Mixed, required: true, default: null },
    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

ConversationNoteSchema.index({ workspaceId: 1, conversationId: 1, createdAt: -1 });

const ConversationNote = mongoose.model("ConversationNote", ConversationNoteSchema);

module.exports = { ConversationNote };

