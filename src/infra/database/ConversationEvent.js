const mongoose = require("mongoose");

const ConversationEventSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    phone: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: [
        "assigned",
        "reassigned",
        "unassigned",
        "status_changed",
        "note_added",
        "transfer_requested",
        "transfer_reviewed",
        "reopened",
        "closed",
      ],
      index: true,
    },
    actor: {
      kind: { type: String, enum: ["employee", "owner", "admin", "system", "api"], required: true },
      actorId: { type: mongoose.Schema.Types.ObjectId, required: false },
      nameSnapshot: { type: String, trim: true, default: "" },
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ConversationEventSchema.index({ workspaceId: 1, conversationId: 1, createdAt: -1 });

const ConversationEvent = mongoose.model("ConversationEvent", ConversationEventSchema);

module.exports = { ConversationEvent };

