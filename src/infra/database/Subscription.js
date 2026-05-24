const mongoose = require("mongoose");

const SubscriptionSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    planSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    planName: { type: String, required: true, trim: true },
    planType: { type: String, enum: ["basic", "pro", "custom"], required: true, index: true },
    status: {
      type: String,
      enum: ["active", "past_due", "cancelled", "expired", "suspended"],
      default: "active",
      index: true,
    },
    currentPeriodStart: { type: Date, required: true, index: true },
    currentPeriodEnd: { type: Date, required: true, index: true },
    durationMonths: { type: Number, required: true, min: 1, max: 24 },
    autoRenewEnabled: { type: Boolean, default: true, index: true },
    cancelAtPeriodEnd: { type: Boolean, default: false, index: true },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    nextBillingAt: { type: Date, default: null },
    lastRenewalAt: { type: Date, default: null },
    razorpaySubscriptionId: { type: String, default: "", index: true },
    razorpayPlanId: { type: String, default: "", index: true },
    latestCheckoutIntentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BillingCheckoutIntent",
      default: null,
      index: true,
    },
    snapshot: {
      price: { type: mongoose.Schema.Types.Mixed, default: {} },
      gst: { type: mongoose.Schema.Types.Mixed, default: {} },
      features: { type: mongoose.Schema.Types.Mixed, default: {} },
      limits: { type: mongoose.Schema.Types.Mixed, default: {} },
      displayFeatures: [{ type: String, trim: true }],
      unavailableFeatures: [{ type: String, trim: true }],
    },
    paymentMode: { type: String, default: "autopay", trim: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    assignmentReason: { type: String, default: "" },
  },
  { timestamps: true }
);

SubscriptionSchema.index({ workspaceId: 1, status: 1, currentPeriodEnd: -1 });
SubscriptionSchema.index({ workspaceId: 1, createdAt: -1 });
SubscriptionSchema.index(
  { workspaceId: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ["active", "past_due", "cancelled"] } } }
);

const Subscription = mongoose.model("Subscription", SubscriptionSchema);

module.exports = { Subscription };

