const mongoose = require("mongoose");

// Stores automation triggers (eventName + payload + the outbound message created).
const EventSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    eventName: { type: String, required: true, trim: true, index: true },
    phone: { type: String, required: true, index: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", index: true },
    templatePayload: { type: Object },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", index: true },
    status: { type: String, enum: ["triggered", "sent", "failed"], default: "triggered" },
    error: { type: Object },
  },
  { timestamps: true }
);

const Event = mongoose.model("Event", EventSchema);

module.exports = { Event };

