const mongoose = require("mongoose");

const AiCreditTransactionSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "AiSubscription", default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    executionKey: { type: String, trim: true, default: null, index: true },
    type: {
      type: String,
      enum: ["purchase", "monthly_reset", "topup_purchase", "usage", "refund", "adjustment"],
      required: true,
      index: true,
    },
    entryType: {
      type: String,
      enum: [
        "included_credit_allocation",
        "included_credit_usage",
        "topup_purchase",
        "topup_usage",
        "manual_adjustment",
        "refund",
        "credit_expiry",
        "subscription_reset",
        "migration_adjustment",
      ],
      default: null,
      index: true,
    },
    source: { type: String, default: "", trim: true, index: true },
    reason: { type: String, default: "", trim: true },
    reference: { type: String, default: "", trim: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "AiConversation", default: null, index: true },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "AiAgent", default: null, index: true },
    actor: {
      actorType: { type: String, enum: ["system", "workspace_user", "super_admin", "admin", "runtime"], default: "system" },
      actorId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
      actorName: { type: String, default: "", trim: true },
    },
    immutable: { type: Boolean, default: true },
    direction: { type: String, enum: ["credit", "debit"], required: true, index: true },
    credits: { type: Number, default: 0 },
    tokens: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "INR", trim: true },
    description: { type: String, default: "", trim: true },
    balanceAfter: {
      remainingCredits: { type: Number, default: 0 },
      remainingTokens: { type: Number, default: 0 },
      remainingIncludedTokens: { type: Number, default: 0 },
      remainingTopupTokens: { type: Number, default: 0 },
      remainingIncludedCredits: { type: Number, default: 0 },
      remainingTopupCredits: { type: Number, default: 0 },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

AiCreditTransactionSchema.index({ workspaceId: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ workspaceId: 1, type: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ workspaceId: 1, entryType: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ workspaceId: 1, source: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ workspaceId: 1, conversationId: 1, createdAt: -1 });
AiCreditTransactionSchema.index({ workspaceId: 1, agentId: 1, createdAt: -1 });
AiCreditTransactionSchema.index(
  { workspaceId: 1, executionKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      executionKey: { $type: "string" },
      type: "usage",
    },
  }
);

const AiCreditTransaction = mongoose.model("AiCreditTransaction", AiCreditTransactionSchema);

module.exports = { AiCreditTransaction };
