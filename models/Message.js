const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", index: true },

    phone: { type: String, required: true, index: true },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },

    whatsappMessageId: { type: String, index: true, default: undefined },

    status: {
      type: String,
      enum: ["queued", "accepted", "sent", "delivered", "read", "failed", "received", "timeout_unknown"],
      default: "queued",
      index: true,
    },
    statusTimestamps: {
      acceptedAt: Date,
      sentAt: Date,
      deliveredAt: Date,
      readAt: Date,
      failedAt: Date,
      receivedAt: Date,
    },

    text: { type: String },
    payload: { type: Object },
    error: { type: Object },
  },
  { timestamps: true }
);

// Only enforce uniqueness when Meta message ID is actually present.
MessageSchema.index(
  { workspaceId: 1, whatsappMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      whatsappMessageId: { $type: "string" },
    },
  }
);

const Message = mongoose.model("Message", MessageSchema);

module.exports = { Message };
