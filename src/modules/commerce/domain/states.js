const ORDER_TRANSITIONS = Object.freeze({
  needs_details: ["needs_review", "cancelled"],
  needs_review: ["needs_details", "awaiting_payment", "cancelled"],
  awaiting_payment: ["confirmed", "needs_review", "cancelled", "requires_attention"],
  confirmed: ["processing", "cancelled", "requires_attention"],
  processing: ["ready", "out_for_delivery", "cancelled", "requires_attention"],
  ready: ["completed", "cancelled", "requires_attention"],
  out_for_delivery: ["completed", "requires_attention"],
  completed: ["requires_attention"], cancelled: ["requires_attention"],
  requires_attention: ["needs_review", "confirmed", "cancelled"],
});
for (const transitions of Object.values(ORDER_TRANSITIONS)) Object.freeze(transitions);
const ATTEMPT_STATES = Object.freeze(["creating", "unknown", "payable", "captured", "expired", "cancelled", "failed", "requires_attention"]);
function assertOrderTransition(from, to) {
  if (typeof from !== "string" || typeof to !== "string") throw new RangeError("Unknown order state");
  if (!Object.hasOwn(ORDER_TRANSITIONS, from) || !Object.hasOwn(ORDER_TRANSITIONS, to)) throw new RangeError("Unknown order state");
  if (from === to) return;
  if (!ORDER_TRANSITIONS[from]?.includes(to)) throw new RangeError(`Order cannot transition from ${from} to ${to}`);
}
function assertCapturedPayment({ payment, attempt, link, expectedAccountId, eventAccountId }) {
  // These resources must be fetched with the attempt's merchant credentials.
  // A webhook payload or browser callback alone is not payment evidence.
  if (!attempt || !Number.isSafeInteger(attempt.amountPaise) || attempt.amountPaise <= 0 || !attempt.providerLinkId || !attempt.reference) throw new RangeError("Invalid checkout attempt");
  if (!payment || payment.status !== "captured" || payment.captured !== true) throw new RangeError("Payment is not captured");
  if (payment.currency !== "INR" || payment.currency !== attempt.currency || payment.amount !== attempt.amountPaise) throw new RangeError("Payment amount or currency mismatch");
  if (!payment.id || !payment.order_id || !link || link.id !== attempt.providerLinkId || link.reference_id !== attempt.reference || link.amount !== attempt.amountPaise || link.currency !== attempt.currency || !Array.isArray(link.payments) || !link.payments.some((p) => p?.payment_id === payment.id)) throw new RangeError("Payment does not belong to this checkout");
  if (link.order_id !== payment.order_id || (attempt.providerOrderId && payment.order_id !== attempt.providerOrderId)) throw new RangeError("Provider order mismatch");
  if (expectedAccountId && eventAccountId && expectedAccountId !== eventAccountId) throw new RangeError("Merchant account mismatch");
}
module.exports = { ORDER_TRANSITIONS, ATTEMPT_STATES, assertOrderTransition, assertCapturedPayment };
