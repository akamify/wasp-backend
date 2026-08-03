const mongoose = require("mongoose");

const BillingCheckoutIntentSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: mongoose.Schema.Types.ObjectId, ref: "Plan", required: true, index: true },
    planSlug: { type: String, required: true, trim: true, lowercase: true, index: true },
    durationMonths: { type: Number, required: true, min: 1, max: 24 },
    mode: { type: String, enum: ["autopay", "one_time"], default: "autopay", index: true },
    checkoutMode: { type: String, enum: ["subscription_mandate", "one_time_order"], default: "subscription_mandate", index: true },
    purpose: { type: String, enum: ["subscription", "renewal"], default: "subscription", index: true },
    recurringIntent: { type: Boolean, default: false, index: true },
    fallbackAllowed: { type: Boolean, default: false },
    fallbackUsed: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["created", "payment_pending", "processing", "paid", "failed", "expired", "cancelled"],
      default: "created",
      index: true,
    },
    purchaseResultState: {
      type: String,
      enum: ["created", "mandate_pending", "activated_with_auto_renew", "activated_manual_renew", "purchase_failed"],
      default: "created",
      index: true,
    },
    providerStatus: { type: String, default: "", index: true },
    amountSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    featuresSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    limitsSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    gstSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    razorpayOrderId: { type: String, default: "", index: true },
    razorpaySubscriptionId: { type: String, default: "", index: true },
    razorpayPaymentId: { type: String, default: "", index: true },
    renewalInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null, index: true },
    renewalSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },
    previousSubscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: "Subscription", default: null, index: true },
    idempotencyKey: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

BillingCheckoutIntentSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
BillingCheckoutIntentSchema.index({ idempotencyKey: 1 }, { unique: true });

const BillingCheckoutIntent = mongoose.model("BillingCheckoutIntent", BillingCheckoutIntentSchema);

module.exports = { BillingCheckoutIntent };
