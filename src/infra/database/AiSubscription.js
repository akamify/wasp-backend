const mongoose = require("mongoose");

const AiSubscriptionSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planKey: { type: String, required: true, trim: true, default: "ai_agent_addon", index: true },
    planName: { type: String, required: true, trim: true, default: "AI Agent Add-on" },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired"],
      default: "active",
      index: true,
    },
    currency: { type: String, default: "INR", trim: true },
    monthlyPrice: { type: Number, default: 2500, min: 0 },
    includedCredits: { type: Number, default: 500, min: 0 },
    includedTokensPerCycle: { type: Number, default: 500000, min: 0 },
    remainingIncludedTokens: { type: Number, default: 500000, min: 0 },
    totalTopupCredits: { type: Number, default: 0, min: 0 },
    remainingTopupTokens: { type: Number, default: 0, min: 0 },
    totalCredits: { type: Number, default: 500, min: 0 },
    remainingCredits: { type: Number, default: 500, min: 0 },
    remainingTokens: { type: Number, default: 500000, min: 0 },
    tokensPerCredit: { type: Number, default: 1000, min: 1 },
    lastResetAt: { type: Date, default: Date.now },
    activatedAt: { type: Date, default: Date.now },
    renewalDate: { type: Date, required: true, index: true },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    latestWalletTransactionMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

AiSubscriptionSchema.index(
  { workspaceId: 1 },
  {
    unique: true,
    name: "uniq_active_ai_subscription_per_workspace",
    partialFilterExpression: { status: "active" },
  }
);
AiSubscriptionSchema.index({ workspaceId: 1, createdAt: -1 });

const AiSubscription = mongoose.model("AiSubscription", AiSubscriptionSchema);

module.exports = { AiSubscription };
