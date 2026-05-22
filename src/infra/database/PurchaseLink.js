const mongoose = require("mongoose");

const PurchaseLinkSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    durationMonths: { type: Number, required: true, min: 1, max: 24 },
    amountSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    gstSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    featuresSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    limitsSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["active", "used", "expired", "cancelled"], default: "active", index: true },
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

PurchaseLinkSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

const PurchaseLink = mongoose.model("PurchaseLink", PurchaseLinkSchema);

module.exports = { PurchaseLink };

