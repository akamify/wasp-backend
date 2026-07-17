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
      enum: [
        "trialing",
        "trial",
        "pending",
        "active",
        "past_due",
        "payment_due",
        "grace_period",
        "cancelled",
        "replaced",
        "expired",
        "free",
        "suspended",
      ],
      default: "active",
      index: true,
    },
    currentPeriodStart: { type: Date, required: true, index: true },
    currentPeriodEnd: { type: Date, required: true, index: true },
    startedAt: { type: Date, default: null },
    purchasedAt: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    durationMonths: { type: Number, required: true, min: 1, max: 24 },
    autoRenewEnabled: { type: Boolean, default: true, index: true },
    cancelAtPeriodEnd: { type: Boolean, default: false, index: true },
    cancelledAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    replacedBySubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },
    paymentDueAt: { type: Date, default: null, index: true },
    gracePeriodEndsAt: { type: Date, default: null, index: true },
    renewalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null, index: true },
    lifecycleLockUntil: { type: Date, default: null, index: true },
    lifecycleLockedAt: { type: Date, default: null },
    scheduledChange: {
      type: {
        type: String,
        enum: ["", "downgrade"],
        default: "",
        index: true,
      },
      planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", default: null, index: true },
      planSlug: { type: String, default: "", trim: true, lowercase: true },
      planName: { type: String, default: "", trim: true },
      effectiveAt: { type: Date, default: null, index: true },
      requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      requestedAt: { type: Date, default: null },
    },
    nextBillingAt: { type: Date, default: null },
    lastRenewalAt: { type: Date, default: null },
    renewalStatus: {
      type: String,
      enum: ["", "none", "scheduled", "processing", "payment_failed", "retry_scheduled", "renewed", "manual_due", "disabled"],
      default: "",
      index: true,
    },
    renewalAttempts: { type: Number, default: 0, min: 0 },
    lastRenewalAttemptAt: { type: Date, default: null, index: true },
    nextRenewalAttemptAt: { type: Date, default: null, index: true },
    renewalMethod: { type: String, enum: ["", "manual", "razorpay_subscription"], default: "", index: true },
    razorpaySubscriptionId: { type: String, default: "", index: true },
    razorpayPlanId: { type: String, default: "", index: true },
    razorpayCustomerId: { type: String, default: "", index: true },
    mandateStatus: {
      type: String,
      enum: ["", "not_setup", "pending", "active", "paused", "cancelled", "failed"],
      default: "",
      index: true,
    },
    paymentMethodSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    billingProvider: { type: String, default: "razorpay", trim: true },
    providerSubscriptionId: { type: String, default: "", index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
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
  { workspaceId: 1 },
  {
    unique: true,
    name: "uniq_active_subscription_per_workspace",
    partialFilterExpression: { status: { $in: ["active", "past_due", "grace_period"] } },
  }
);
SubscriptionSchema.index(
  { workspaceId: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ["active", "past_due", "cancelled"] } } }
);

const Subscription = mongoose.model("Subscription", SubscriptionSchema);

module.exports = { Subscription };
