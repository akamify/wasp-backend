const mongoose = require("mongoose");

const AiAddonPlanSchema = new mongoose.Schema(
  {
    planKey: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: "" },
    status: {
      type: String,
      enum: ["draft", "published", "archived", "disabled"],
      default: "draft",
      index: true,
    },
    currency: { type: String, trim: true, default: "INR", maxlength: 8 },
    monthlyPrice: { type: Number, min: 0, default: 2500 },
    includedCredits: { type: Number, min: 0, default: 500 },
    tokensPerCredit: { type: Number, min: 1, default: 1000 },
    durationDays: { type: Number, min: 1, default: 30 },
    limits: {
      maxAgents: { type: Number, min: 0, default: 1 },
      maxKbStorageMb: { type: Number, min: 0, default: 500 },
      maxInputTokens: { type: Number, min: 1, default: 4096 },
      maxTokensPerReply: { type: Number, min: 1, default: 1024 },
    },
    renewalPolicy: {
      mode: { type: String, enum: ["auto_renew", "manual"], default: "auto_renew" },
      expireUnusedCredits: { type: Boolean, default: true },
    },
    sortOrder: { type: Number, min: 0, default: 0 },
    featured: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true }
);

AiAddonPlanSchema.index({ status: 1, sortOrder: 1, createdAt: -1 });

const AiAddonPlan = mongoose.model("AiAddonPlan", AiAddonPlanSchema);

module.exports = { AiAddonPlan };
