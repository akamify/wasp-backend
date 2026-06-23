const mongoose = require("mongoose");

const ConversationSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    phone: { type: String, required: true, index: true },
    lastMessageAt: { type: Date, index: true },
    lastMessage: { type: String, default: "" },
    lastMessageDirection: { type: String, enum: ["inbound", "outbound"], default: null },
    lastMessageStatus: { type: String, default: null },
    lastInboundAt: { type: Date, index: true, default: null },
    lastInboundMessageAt: { type: Date, index: true, default: null },
    lastMessagePreview: { type: String },
    unreadCount: { type: Number, default: 0 },
    lastReadAt: { type: Date, default: null },
    automationPausedAt: { type: Date, default: null, index: true },
    automationPauseReason: { type: String, trim: true, default: null },
    automationPausedByFlowSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FlowSession",
      default: null,
    },

    // CRM ownership + locking + SLA/unread (additive; preserves existing inbox behavior).
    assignmentVersion: { type: Number, default: 0 },
    assignedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: Object, default: null },
    assignmentMode: { type: String, default: null },
    assignmentReason: { type: String, default: "" },
    assignmentLockedUntil: { type: Date, default: null, index: true },

    ownerUnreadCount: { type: Number, default: 0 },
    employeeUnreadCount: { type: Number, default: 0 },
    lastCustomerMessageAt: { type: Date, default: null, index: true },
    customerServiceWindowExpiresAt: { type: Date, default: null, index: true },
    serviceWindowStatus: { type: String, enum: ["open", "closed"], default: "closed" },
    canReply: { type: Boolean, default: false },
    serviceWindowUpdatedAt: { type: Date, default: null },
    lastEmployeeReplyAt: { type: Date, default: null, index: true },
    firstResponseAt: { type: Date, default: null },
    firstResponseDurationMs: { type: Number, default: null },
    closedAt: { type: Date, default: null, index: true },
    reopenedAt: { type: Date, default: null, index: true },

    leadStatus: {
      type: String,
      enum: ["OPEN", "PENDING", "FOLLOW_UP", "WON", "LOST", "REOPENED", "UNASSIGNED"],
      default: "UNASSIGNED",
      index: true,
    },
    leadStatusUpdatedAt: { type: Date, default: null },
    leadStatusUpdatedBy: { type: Object, default: null },
    lastLeadCreatedAt: { type: Date, default: null },

    normalizedPhone: { type: String, default: "", index: true },
  },
  { timestamps: true }
);

ConversationSchema.index({ workspaceId: 1, wabaId: 1, phone: 1 }, { unique: true });
ConversationSchema.index({ workspaceId: 1, assignedEmployeeId: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", ConversationSchema);

module.exports = { Conversation };

