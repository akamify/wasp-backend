const { BillingCheckoutIntent } = require("@infra/database/BillingCheckoutIntent");

async function createIntent(payload) {
  return BillingCheckoutIntent.create(payload);
}

async function findByRazorpayOrderId(orderId) {
  return BillingCheckoutIntent.findOne({ razorpayOrderId: String(orderId || "") });
}

async function findByRazorpaySubscriptionId(subscriptionId) {
  return BillingCheckoutIntent.findOne({ razorpaySubscriptionId: String(subscriptionId || "") });
}

async function claimProcessingByRazorpayOrderId(orderId) {
  return BillingCheckoutIntent.findOneAndUpdate(
    { razorpayOrderId: String(orderId || ""), status: "payment_pending" },
    { $set: { status: "processing" } },
    { new: true }
  );
}

async function claimProcessingByRazorpaySubscriptionId(subscriptionId) {
  return BillingCheckoutIntent.findOneAndUpdate(
    { razorpaySubscriptionId: String(subscriptionId || ""), status: { $in: ["payment_pending", "created"] } },
    { $set: { status: "processing" } },
    { new: true }
  );
}

async function markPaymentPending(id, patch = {}) {
  return BillingCheckoutIntent.findByIdAndUpdate(
    id,
    { $set: { ...patch, status: "payment_pending" } },
    { new: true }
  );
}

async function markPaid(id, patch = {}, options = {}) {
  return BillingCheckoutIntent.findByIdAndUpdate(
    id,
    { $set: { ...patch, status: "paid" } },
    { new: true, session: options.session }
  );
}

async function markFailed(id, patch = {}, options = {}) {
  return BillingCheckoutIntent.findByIdAndUpdate(
    id,
    { $set: { ...patch, status: "failed" } },
    { new: true, session: options.session }
  );
}

async function markCancelled(id, patch = {}, options = {}) {
  return BillingCheckoutIntent.findByIdAndUpdate(
    id,
    { $set: { ...patch, status: "cancelled" } },
    { new: true, session: options.session }
  );
}

async function updateIntent(id, patch = {}, options = {}) {
  return BillingCheckoutIntent.findByIdAndUpdate(
    id,
    { $set: { ...patch } },
    { new: true, session: options.session }
  );
}

module.exports = {
  createIntent,
  findByRazorpayOrderId,
  findByRazorpaySubscriptionId,
  claimProcessingByRazorpayOrderId,
  claimProcessingByRazorpaySubscriptionId,
  markPaymentPending,
  markPaid,
  markFailed,
  markCancelled,
  updateIntent,
};

