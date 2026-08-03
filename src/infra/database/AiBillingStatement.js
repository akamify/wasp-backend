const mongoose = require("mongoose");

const AiBillingStatementSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "AiSubscription", default: null, index: true },
    periodKey: { type: String, required: true, trim: true, index: true },
    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true, index: true },
    workspaceSnapshot: {
      name: { type: String, default: "", trim: true },
      businessName: { type: String, default: "", trim: true },
      slug: { type: String, default: "", trim: true },
    },
    planSnapshot: {
      subscriptionPlan: { type: String, default: "", trim: true },
      aiAddonPlan: { type: String, default: "", trim: true },
      currency: { type: String, default: "INR", trim: true },
      tokensPerCredit: { type: Number, default: 1000, min: 1 },
    },
    balances: {
      openingCredits: { type: Number, default: 0 },
      openingTokens: { type: Number, default: 0 },
      includedCreditsAdded: { type: Number, default: 0 },
      includedTokensAdded: { type: Number, default: 0 },
      topupCreditsPurchased: { type: Number, default: 0 },
      topupTokensPurchased: { type: Number, default: 0 },
      creditsConsumed: { type: Number, default: 0 },
      tokensConsumed: { type: Number, default: 0 },
      creditsRefunded: { type: Number, default: 0 },
      tokensRefunded: { type: Number, default: 0 },
      creditsAdjusted: { type: Number, default: 0 },
      tokensAdjusted: { type: Number, default: 0 },
      includedCreditsExpired: { type: Number, default: 0 },
      includedTokensExpired: { type: Number, default: 0 },
      closingCredits: { type: Number, default: 0 },
      closingTokens: { type: Number, default: 0 },
    },
    activity: {
      totalAiRequests: { type: Number, default: 0 },
      totalRuntimeExecutions: { type: Number, default: 0 },
      totalConversationsHandled: { type: Number, default: 0 },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    reconciledAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

AiBillingStatementSchema.index({ workspaceId: 1, periodKey: 1 }, { unique: true });
AiBillingStatementSchema.index({ workspaceId: 1, periodStart: -1 });

const AiBillingStatement = mongoose.model("AiBillingStatement", AiBillingStatementSchema);

module.exports = { AiBillingStatement };
