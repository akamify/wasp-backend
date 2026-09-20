const { HttpError } = require("@shared/utils/httpError");
const { fail, assertProviderOrder } = require("./payments");
const amount = (value) => ({ value, offset: 100 });
function configurationName(value) {
  if (typeof value !== "string" || !value.length || value.length > 60 || [".", ".."].includes(value) || /[\x00-\x1f\x7f/\\?#]/.test(value))
    throw new HttpError(400, "Enter a valid Meta payment configuration name.");
  return value;
}
function assertConfiguration(response, name, gateway) {
  const rows = response?.data;
  if (!Array.isArray(rows) || rows.length !== 1) fail("Meta payment configuration could not be verified.");
  const row = rows[0];
  if (!row || row.configuration_name !== name || row.status !== "Active" || String(row.provider_name).toLowerCase() !== "razorpay"
      || !gateway.identityVerified || !/^acc_[A-Za-z0-9]{1,64}$/.test(gateway.merchantAccountId || "")
      || row.provider_mid !== gateway.merchantAccountId)
    fail("An active Meta configuration linked to this verified Razorpay merchant is required.");
  return row;
}
function orderDetails(attempt, order, catalogId, address, now = new Date()) {
  const expiry = new Date(attempt.expiresAt).getTime();
  if (attempt.environment !== "live" || order.environment !== "live" || order.totalPaise !== attempt.amountPaise
      || !Number.isSafeInteger(attempt.amountPaise) || attempt.amountPaise < 100 || attempt.amountPaise > 50000000
      || !/^\d{1,30}$/.test(catalogId || "") || !Array.isArray(order.items) || !order.items.length || order.items.length > 100
      || !/^[A-Za-z0-9_.-]{1,35}$/.test(attempt.reference || "") || !Number.isFinite(expiry) || expiry < now.getTime() + 300000)
    fail("Native checkout requires a live INR catalog order with at least five minutes remaining and total at most INR 500,000.");
  const items = order.items.map((item) => {
    if (!item.sku || typeof item.name !== "string" || !item.name.length || !Number.isSafeInteger(item.quantity) || item.quantity < 1
        || !Number.isSafeInteger(item.unitPricePaise) || item.unitPricePaise < 0) fail();
    return { retailer_id: item.sku, name: Array.from(item.name).slice(0, 60).join(""), amount: amount(item.unitPricePaise), quantity: item.quantity };
  });
  const subtotal = items.reduce((sum, item) => sum + item.amount.value * item.quantity, 0);
  if (!Number.isSafeInteger(subtotal) || subtotal !== order.subtotalPaise || !Number.isSafeInteger(order.deliveryPaise)
      || order.deliveryPaise < 0 || subtotal + order.deliveryPaise !== attempt.amountPaise) fail();
  let beneficiaries;
  if (order.fulfillmentMethod === "delivery") {
    if (!address || address.country !== "IN" || !/^[1-9]\d{5}$/.test(address.postalCode || "")
        || !["name", "line1", "city", "state"].every((key) => typeof address[key] === "string" && address[key].trim())
        || address.name.length > 200 || address.line1.length > 100 || (address.line2 || "").length > 100)
      fail("Native delivery requires a complete Indian shipping address within Meta field limits.");
    beneficiaries = [{ name: address.name, address_line1: address.line1, ...(address.line2 ? { address_line2: address.line2 } : {}),
      city: address.city, state: address.state, country: "India", postal_code: address.postalCode }];
  } else if (order.fulfillmentMethod !== "pickup") fail();
  const interactive = { type: "order_details", body: { text: `Review and pay for order ${order.orderNumber}. Prices include applicable tax.` },
    action: { name: "review_and_pay", parameters: JSON.stringify({ reference_id: attempt.reference, type: "physical-goods",
      ...(beneficiaries ? { beneficiaries } : {}), currency: "INR", total_amount: amount(attempt.amountPaise),
      payment_settings: [{ type: "payment_gateway", payment_gateway: { type: "razorpay",
        configuration_name: configurationName(attempt.nativeConfigurationName), razorpay: { receipt: attempt.reference } } }],
      order: { status: "pending", catalog_id: catalogId, items, subtotal: amount(subtotal),
        // Prices already include tax. Adding the included tax again would overcharge.
        tax: { ...amount(0), description: "Included in item and delivery prices" }, shipping: amount(order.deliveryPaise),
        expiration: { timestamp: String(Math.floor(new Date(attempt.expiresAt).getTime() / 1000)), description: "Checkout reservation expires at this time." } } }) } };
  const message = { messaging_product: "whatsapp", recipient_type: "individual", to: order.customerPhone, type: "interactive", interactive };
  if (Buffer.byteLength(JSON.stringify(message), "utf8") > 32768) fail("This order exceeds the native message size limit. Use a hosted Payment Link.");
  return interactive;
}
function lookupPayment(response, attempt) {
  if (!Array.isArray(response?.payments) || response.payments.length !== 1) fail("Native payment lookup is unresolved.");
  const row = response.payments[0], transactions = row?.transactions || [];
  if (!row || row.reference_id !== attempt.reference || row.currency !== "INR" || row.amount?.offset !== 100 || row.amount.value !== attempt.amountPaise
      || !["pending", "captured"].includes(row.status) || !Array.isArray(transactions) || transactions.length > 100
      || transactions.some((t) => !t || t.type !== "razorpay" || !["pending", "success", "failed"].includes(t.status))) fail();
  const success = transactions.filter((t) => t.status === "success");
  if (success.length > 1 || (row.status === "captured") !== (success.length === 1)) fail();
  return row;
}
function assertNativeCapture({ lookup, attempt, payment, providerOrder, gateway }) {
  const row = lookupPayment({ payments: [lookup] }, attempt), txn = row.transactions?.find((t) => t.status === "success");
  if (!txn || !/^pay_[A-Za-z0-9]{1,80}$/.test(payment?.id || "") || !/^order_[A-Za-z0-9]{1,80}$/.test(txn.id || "")
      || txn.pg_transaction_id !== payment.id || txn.id !== payment.order_id || payment.status !== "captured" || payment.captured !== true
      || payment.amount !== attempt.amountPaise || payment.currency !== "INR" || !Number.isSafeInteger(payment.amount_refunded)
      || payment.amount_refunded < 0 || payment.amount_refunded > payment.amount || gateway.merchantAccountId !== attempt.nativeMerchantAccountId
      || (payment.account_id && payment.account_id !== attempt.nativeMerchantAccountId)
      || (attempt.providerOrderId && attempt.providerOrderId !== payment.order_id)) fail();
  assertProviderOrder(providerOrder, payment, attempt);
}
function orderStatus(reference, status, text) {
  if (!["processing", "shipped", "completed", "canceled"].includes(status)) fail();
  return { type: "order_status", body: { text: text.slice(0, 1024) }, action: { name: "review_order",
    parameters: JSON.stringify({ reference_id: reference, order: { status } }) } };
}
function storedInteractive(interactive) {
  if (interactive?.type !== "order_details") return interactive;
  const { beneficiaries: _privateAddress, ...parameters } = JSON.parse(interactive.action.parameters);
  return { ...interactive, action: { ...interactive.action, parameters: JSON.stringify(parameters) } };
}
module.exports = { configurationName, assertConfiguration, orderDetails, lookupPayment, assertNativeCapture, orderStatus, storedInteractive };
