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
    senderType: {
      type: String,
      enum: ["user", "business", "automation", "agent", "system"],
      default: null,
      index: true,
    },
    source: {
      type: String,
      enum: ["whatsapp", "automation", "campaign", "api", "manual"],
      default: null,
      index: true,
    },
    receivedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    sortAt: { type: Date, default: null, index: true },
    replyToMessageId: { type: String, trim: true, default: null },
    triggeredByMessageId: { type: String, trim: true, default: null, index: true },

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

MessageSchema.pre("validate", function normalizeMessageTimeline() {
  const inbound = this.direction === "inbound";
  this.receivedAt =
    this.receivedAt ||
    (inbound ? this.statusTimestamps?.receivedAt || this.createdAt : null);
  this.sentAt =
    this.sentAt ||
    (!inbound ? this.statusTimestamps?.sentAt || this.createdAt : null);
  this.sortAt =
    this.sortAt ||
    (inbound ? this.receivedAt : this.sentAt) ||
    this.createdAt ||
    new Date();
  this.senderType =
    this.senderType ||
    (inbound
      ? "user"
      : this.sentBy?.kind === "system"
        ? "automation"
        : this.sentBy?.kind === "api"
          ? "business"
          : "agent");
  this.source =
    this.source ||
    (inbound
      ? "whatsapp"
      : this.campaignId
        ? "campaign"
        : this.sentBy?.kind === "system"
          ? "automation"
          : this.sentBy?.kind === "api"
            ? "api"
            : "manual");
});

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
MessageSchema.index({ workspaceId: 1, wabaId: 1, phone: 1, sortAt: 1, createdAt: 1 });
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
