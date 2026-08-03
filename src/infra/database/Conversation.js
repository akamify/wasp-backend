const mongoose = require("mongoose");
const {
  AI_STATE_VALUES,
  normalizeAiState,
} = require("@modules/ai-agents/constants/aiRuntime.constants");

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

    aiAgentId: { type: mongoose.Schema.Types.ObjectId, ref: "AiAgent", default: null, index: true },
    aiConversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AiConversation", default: null, index: true },
    aiState: {
      type: String,
      enum: AI_STATE_VALUES,
      default: null,
      index: true,
      set: (value) => normalizeAiState(value, { fallback: null }),
      get: (value) => normalizeAiState(value, { fallback: null }),
    },
    aiLastInboundAt: { type: Date, default: null, index: true },
    aiLastReplyAt: { type: Date, default: null, index: true },
    aiHandoverAt: { type: Date, default: null, index: true },
    aiHandoverReason: { type: String, trim: true, default: null },
    aiBusinessHoursStatus: { type: String, enum: ["within_hours", "after_hours"], default: null, index: true },
    aiSlaDueAt: { type: Date, default: null, index: true },
    aiEscalatedAt: { type: Date, default: null, index: true },
    aiEscalationLevel: { type: Number, default: 0, min: 0 },
    aiEscalationReason: { type: String, trim: true, default: null },
    aiLastErrorAt: { type: Date, default: null },
    aiLastErrorMessage: { type: String, trim: true, default: null },
    aiProcessingLockUntil: { type: Date, default: null, index: true },
    aiProcessingMessageId: { type: String, trim: true, default: null },
    aiProcessingLockOwner: { type: String, trim: true, default: null },

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
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

ConversationSchema.index({ workspaceId: 1, wabaId: 1, phone: 1 }, { unique: true });
ConversationSchema.index({ workspaceId: 1, assignedEmployeeId: 1, lastMessageAt: -1 });

const Conversation = mongoose.model("Conversation", ConversationSchema);

module.exports = { Conversation };

