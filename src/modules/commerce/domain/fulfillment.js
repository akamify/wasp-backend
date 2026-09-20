const { HttpError } = require("@shared/utils/httpError");
const nextStatus = (order) => ({ confirmed: "processing", processing: order.fulfillmentMethod === "pickup" ? "ready" : "out_for_delivery",
  ready: order.fulfillmentMethod === "pickup" ? "completed" : null,
  out_for_delivery: order.fulfillmentMethod === "delivery" ? "completed" : null })[order.status];
function assertFulfillment(order, input) {
  if (order.revision !== input.revision || order.paymentStatus !== "captured" || !order.paidAttemptId || order.activeAttemptId)
    throw new HttpError(409, "Order changed or payment verification is incomplete.");
  if (order.status === "requires_attention" && order.attentionReason === "payment_after_stock_release"
      && input.status === "confirmed" && input.acknowledgeAttention === true) return "allocate";
  if (nextStatus(order) !== input.status) throw new HttpError(409, "This fulfillment transition is not available for the order.");
  return "advance";
}
module.exports = { nextStatus, assertFulfillment };
