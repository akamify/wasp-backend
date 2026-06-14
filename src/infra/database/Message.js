const mongoose = require("mongoose");

const MessageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      index: true,
      default: undefined,
    },
    campaignRunId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampaignRun",
      index: true,
      default: undefined,
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Contact",
      index: true,
      default: undefined,
    },
    campaignRunFinalized: { type: Boolean, default: false },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", index: true },

    phone: { type: String, required: true, index: true },
    direction: { type: String, enum: ["outbound", "inbound"], required: true },

    whatsappMessageId: { type: String, index: true, default: undefined },

    status: {
      type: String,
      enum: ["queued", "processing", "accepted", "sent", "delivered", "read", "failed", "received", "timeout_unknown"],
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
      readByBusinessAt: Date,
    },
    readReceiptSentAt: { type: Date, default: null, index: true },

    sentBy: {
      kind: { type: String, enum: ["owner", "admin", "employee", "system", "api"], required: true, default: "system" },
      actorId: { type: mongoose.Schema.Types.ObjectId, required: false },
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    lastAssignedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    lastAssignedAt: { type: Date, default: null },
    leadStatusSnapshot: { type: String, default: null },

    text: { type: String },
    type: { type: String, trim: true, default: null },
    buttons: {
      type: [
        {
          _id: false,
          id: { type: String, trim: true, required: true },
          title: { type: String, trim: true, required: true },
        },
      ],
      default: undefined,
    },
    payload: { type: Object },
    error: { type: Object },
  },
  { timestamps: true }
);

// Only enforce uniqueness when Meta message ID is actually present.
MessageSchema.index(
  { workspaceId: 1, wabaId: 1, whatsappMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      whatsappMessageId: { $type: "string" },
    },
  }
);
MessageSchema.index(
  { campaignRunId: 1, contactId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      campaignRunId: { $type: "objectId" },
      contactId: { $type: "objectId" },
    },
  }
);
MessageSchema.index(
  { campaignRunId: 1, phone: 1 },
  {
    unique: true,
    partialFilterExpression: {
      campaignRunId: { $type: "objectId" },
    },
  }
);

const Message = mongoose.model("Message", MessageSchema);

module.exports = { Message };
