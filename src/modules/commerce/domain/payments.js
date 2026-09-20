const { HttpError } = require("@shared/utils/httpError");
const { hash } = require("./gateway");
const fail = (message = "Provider resource does not match the checkout.") => { throw new HttpError(409, message); };
const same = (a, b) => String(a) === String(b);
const requestHash = (orderId, input) => hash(JSON.stringify([String(orderId), input.gatewayConnectionId, input.revision, input.mode || "razorpay_payment_link"]));
function linkPayload(attempt) {
  return { amount: attempt.amountPaise, currency: "INR", accept_partial: false, reference_id: attempt.reference,
    expire_by: Math.floor(new Date(attempt.expiresAt).getTime() / 1000),
    description: `AIWizChat order ${attempt.orderId}`, notify: { sms: false, email: false }, reminder_enable: false };
}
function assertLink(link, attempt) {
  if (!link || !/^plink_[A-Za-z0-9]{1,80}$/.test(link.id || "") || (attempt.providerLinkId && link.id !== attempt.providerLinkId)
      || link.reference_id !== attempt.reference || link.amount !== attempt.amountPaise || link.currency !== "INR"
      || link.accept_partial !== false || link.expire_by !== Math.floor(new Date(attempt.expiresAt).getTime() / 1000)
      || !["created", "paid", "partially_paid", "expired", "cancelled"].includes(link.status)) fail();
  if (link.payments != null && (!Array.isArray(link.payments) || link.payments.length > 100)) fail();
  return link;
}
function foundLink(data, attempt) {
  if (data?.id) return assertLink(data, attempt);
  // Razorpay documents a single entity for a reference lookup and a
  // payment_links collection for list responses. Never choose a fuzzy match.
  const links = data?.payment_links;
  if (!Array.isArray(links) || links.length > 100) fail("Invalid payment-link lookup response.");
  if (!links.length) return null;
  if (links.length !== 1) fail("Checkout reference is ambiguous.");
  return assertLink(links[0], attempt);
}
function paymentUrl(link) {
  try {
    const url = new URL(link.short_url);
    if (url.protocol !== "https:" || !["rzp.io", "rzp.me"].includes(url.hostname) || url.username || url.password || url.port || url.hash) fail();
    return url.toString();
  } catch { fail("Invalid hosted payment URL."); }
}
function assertProviderOrder(order, payment, attempt) {
  if (order?.id !== payment.order_id || order.amount !== attempt.amountPaise || order.currency !== "INR"
      || order.status !== "paid" || !Number.isSafeInteger(order.amount_paid) || order.amount_paid < attempt.amountPaise) fail();
}
function assertRefund(refund, payment) {
  if (!/^rfnd_[A-Za-z0-9]{1,80}$/.test(refund?.id || "") || refund.payment_id !== payment.providerPaymentId || refund.currency !== "INR"
      || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > payment.amountPaise
      || !["pending", "processed", "failed"].includes(refund.status)) fail("Refund does not match the verified merchant payment.");
}
function attemptDto(attempt, now = new Date()) {
  const fields = ["orderId", "gatewayConnectionId", "orderRevision", "environment", "mode", "reference", "amountPaise", "currency", "status",
    "active", "expiresAt", "lastCheckedAt", "lastError", "cancelRequestedAt", "createdAt", "revision"];
  return { id: String(attempt._id), ...Object.fromEntries(fields.map((k) => [k, attempt[k]])),
    paymentUrl: attempt.active && attempt.status === "payable" && !attempt.cancelRequestedAt && new Date(attempt.expiresAt) > now ? attempt.paymentUrl : "" };
}
function paymentDto(payment) {
  const fields = ["orderId", "attemptId", "gatewayConnectionId", "environment", "providerPaymentId", "providerOrderId", "status", "amountPaise",
    "currency", "method", "capturedAt", "verifiedAt", "refundedPaise", "overpayment", "lastError", "createdAt"];
  return { id: String(payment._id), ...Object.fromEntries(fields.map((k) => [k, payment[k]])) };
}
const page = (rows, limit, dto) => ({ items: rows.slice(0, limit).map(dto), nextCursor: rows.length > limit ? String(rows[limit - 1]._id) : null });
module.exports = { same, fail, requestHash, linkPayload, assertLink, foundLink, paymentUrl, assertProviderOrder, assertRefund, attemptDto, paymentDto, page };
