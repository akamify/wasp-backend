const mongoose = require("mongoose");

const InboundMessageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      default: null,
    },
    phoneNumberId: { type: String, required: true, trim: true },
    from: { type: String, required: true, trim: true },
    whatsappMessageId: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    text: { type: mongoose.Schema.Types.Mixed, default: null },
    buttonReply: { type: mongoose.Schema.Types.Mixed, default: null },
    listReply: { type: mongoose.Schema.Types.Mixed, default: null },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    processingStatus: {
      type: String,
      enum: ["pending", "processed", "failed", "skipped"],
      default: "pending",
    },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    receivedAt: { type: Date, required: true, default: Date.now },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

InboundMessageSchema.index(
  { workspaceId: 1, whatsappMessageId: 1 },
  { unique: true }
);

const InboundMessage = mongoose.model("InboundMessage", InboundMessageSchema);

module.exports = { InboundMessage };
