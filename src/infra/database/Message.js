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
    contextWamid: { type: String, trim: true, default: null, index: true },
    replyToPreview: { type: String, trim: true, default: null },
    replyToType: { type: String, trim: true, default: null },
    interactiveReplyId: { type: String, trim: true, default: null },
    interactiveReplyTitle: { type: String, trim: true, default: null },
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
    statusHistory: {
      type: [{ _id: false, status: String, timestamp: Date, error: mongoose.Schema.Types.Mixed }],
      default: [],
    },
    tracking: {
      trackingToken: { type: String, trim: true, default: null },
      clicked: { type: Boolean, default: false, index: true },
      clickCount: { type: Number, default: 0 },
      firstClickedAt: { type: Date, default: null },
      lastClickedAt: { type: Date, default: null, index: true },
    },
    conversion: {
      converted: { type: Boolean, default: false, index: true },
      totalRevenue: { type: Number, default: 0 },
      lastConversionAt: { type: Date, default: null, index: true },
      events: {
        type: [
          {
            _id: false,
            eventId: { type: mongoose.Schema.Types.ObjectId, ref: "ConversionEvent" },
            eventName: { type: String, trim: true, default: null },
            value: { type: Number, default: 0 },
            currency: { type: String, trim: true, default: null },
            source: { type: String, trim: true, default: null },
            timestamp: { type: Date, default: null },
          },
        ],
        default: [],
      },
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    lastAssignedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    lastAssignedAt: { type: Date, default: null },
    leadStatusSnapshot: { type: String, default: null },

    text: { type: String },
    displayText: { type: String, trim: true, default: null },
    previewText: { type: String, trim: true, default: null },
    type: { type: String, trim: true, default: null },
    buttonReply: {
      id: { type: String, trim: true, default: null },
      title: { type: String, trim: true, default: null },
    },
    listReply: {
      id: { type: String, trim: true, default: null },
      title: { type: String, trim: true, default: null },
      description: { type: String, trim: true, default: null },
    },
    interactive: { type: mongoose.Schema.Types.Mixed, default: null },
    flowSessionId: { type: mongoose.Schema.Types.ObjectId, ref: "FlowSession", default: null, index: true },
    flowId: { type: mongoose.Schema.Types.ObjectId, ref: "Flow", default: null, index: true },
    nodeId: { type: String, trim: true, default: null },
    aiAgentId: { type: mongoose.Schema.Types.ObjectId, ref: "AiAgent", default: null, index: true },
    aiConversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AiConversation", default: null, index: true },
    aiExecutionKey: { type: String, trim: true, default: null, index: true },
    aiExecutionStartedAt: { type: Date, default: null, index: true },
    aiStatus: {
      type: String,
      enum: ["processing", "replied", "handover", "skipped", "failed"],
      default: null,
      index: true,
    },
    aiAction: { type: String, enum: ["reply", "handover", "blocked"], default: null },
    aiProcessedAt: { type: Date, default: null, index: true },
    aiReplyMessageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
    aiReason: { type: String, trim: true, default: null },
    aiError: { type: String, trim: true, default: null },
    idempotencyKey: { type: String, trim: true, default: null, index: true },
    providerDispatchStartedAt: { type: Date, default: null, index: true },
    providerDispatchCompletedAt: { type: Date, default: null, index: true },
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
    messageKind: { type: String, enum: ["service", "template", "automation", "campaign"], default: null, index: true },
    chargeAmount: { type: Number, default: 0 },
    chargeCategory: { type: String, default: null },
    platformWalletCharged: { type: Boolean, default: false },
    chargeSource: { type: String, enum: ["wallet", "free_service_window", "none"], default: "none" },
    walletTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    metaBillingHandledBy: { type: String, default: "Meta billing hub / WABA billing" },
    sendFailureCode: { type: String, default: null },
    sendFailureMessage: { type: String, default: null },
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
  this.messageKind =
    this.messageKind ||
    (this.campaignId
      ? "campaign"
      : this.type === "template" || this.templateId
        ? "template"
        : this.source === "automation"
          ? "automation"
          : "service");
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
  { workspaceId: 1, "tracking.trackingToken": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "tracking.trackingToken": { $type: "string" },
    },
  }
);
MessageSchema.index({ workspaceId: 1, contactId: 1, direction: 1, createdAt: -1 });
MessageSchema.index(
  { workspaceId: 1, aiExecutionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      direction: "inbound",
      aiExecutionKey: { $type: "string" },
    },
  }
);
MessageSchema.index(
  { workspaceId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string" },
    },
  }
);
MessageSchema.index({ workspaceId: 1, campaignId: 1, "tracking.clicked": 1 });
MessageSchema.index({ workspaceId: 1, templateId: 1, "conversion.converted": 1 });
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
