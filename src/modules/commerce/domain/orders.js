const { HttpError } = require("@shared/utils/httpError");
const { parseRupees, calculateQuote } = require("./money");
const EDITABLE = ["needs_details", "needs_review"];
const invalid = (code) => { const error = new HttpError(400, "Invalid WhatsApp cart."); error.commerceCode = code; throw error; };
function normalizeCart(message) {
  if (!message || message.type !== "order" || typeof message.id !== "string" || !message.id.length || message.id.length > 512
      || typeof message.from !== "string" || !/^[1-9]\d{7,14}$/.test(message.from) || !/^[1-9]\d{0,11}$/.test(String(message.timestamp || ""))) invalid("invalid_order_message");
  const receivedAt = new Date(Number(message.timestamp) * 1000);
  if (!Number.isFinite(receivedAt.getTime())) invalid("invalid_order_message");
  const cart = message.order;
  if (!cart || typeof cart.catalog_id !== "string" || !/^\d{1,30}$/.test(cart.catalog_id)
      || !Array.isArray(cart.product_items) || !cart.product_items.length || cart.product_items.length > 100
      || (cart.text != null && (typeof cart.text !== "string" || cart.text.length > 4096))) invalid("invalid_cart");
  const seen = new Set();
  const items = cart.product_items.map((item) => {
    const sku = item?.product_retailer_id;
    if (typeof sku !== "string" || !sku.trim() || sku.length > 100 || /[\x00-\x1f\x7f]/.test(sku) || seen.has(sku)) invalid("invalid_or_duplicate_sku");
    seen.add(sku);
    const rawQuantity = item.quantity;
    if (!(typeof rawQuantity === "number" || typeof rawQuantity === "string") || !/^[1-9]\d{0,4}$/.test(String(rawQuantity))) invalid("invalid_quantity");
    const quantity = Number(rawQuantity);
    if (quantity > 10000 || !Number.isSafeInteger(quantity)) invalid("invalid_quantity");
    if (item.currency !== "INR") invalid("unsupported_currency");
    let unitPricePaise;
    try {
      if (typeof item.item_price !== "string" && typeof item.item_price !== "number") invalid("invalid_source_price");
      unitPricePaise = parseRupees(String(item.item_price));
    } catch { invalid("invalid_source_price"); }
    return { sku, quantity, unitPricePaise };
  });
  return { inboundMessageId: message.id, customerPhone: message.from, receivedAt, catalogId: cart.catalog_id,
    customerNote: cart.text || "", items };
}
function quoteFromProducts(items, products, deliveryPaise = 0, deliveryTaxRateBps = null, sourceItems = []) {
  const bySku = new Map(products.map((product) => [product.sku, product]));
  const source = new Map(sourceItems.map((item) => [item.sku, item]));
  const warnings = [], blockers = [];
  const lines = items.map((item) => {
    const product = bySku.get(item.sku);
    if (!product) invalid("unknown_product");
    if (product.archivedAt || !product.available) blockers.push(`unavailable:${item.sku}`);
    if (!product.taxConfirmed) blockers.push(`tax_unconfirmed:${item.sku}`);
    if (product.trackInventory && product.stockOnHand - product.stockReserved < item.quantity) blockers.push(`insufficient_stock:${item.sku}`);
    if (source.get(item.sku)?.unitPricePaise !== undefined && source.get(item.sku).unitPricePaise !== product.pricePaise) warnings.push(`price_changed:${item.sku}`);
    if (source.get(item.sku)?.quantity !== undefined && source.get(item.sku).quantity !== item.quantity) warnings.push(`quantity_changed:${item.sku}`);
    return { productId: product._id, sku: product.sku, name: product.name, quantity: item.quantity,
      unitPricePaise: product.pricePaise, productRevision: product.revision, taxRateBps: product.taxConfirmed ? product.taxRateBps : null };
  });
  for (const item of sourceItems) if (!items.some((line) => line.sku === item.sku)) warnings.push(`removed:${item.sku}`);
  let quote;
  try { quote = calculateQuote(lines, deliveryPaise, deliveryTaxRateBps); } catch { invalid("invalid_quote"); }
  return { ...quote, warnings: [...warnings, ...blockers], blockers,
    productRevisions: lines.map((line) => ({ productId: String(line.productId), revision: line.productRevision })) };
}
function assertEditable(order) {
  if (!EDITABLE.includes(order.status) || order.paymentStatus !== "unpaid" || order.activeAttemptId || order.paidAttemptId)
    throw new HttpError(409, "Order cannot be edited while checkout or payment is active.");
}
function orderDto(order, details = false) {
  const fields = ["recommendedOutletId", "branchRoutingStatus", "manualDeliveryId", "orderNumber", "environment", "status", "paymentStatus", "currency", "customerPhone", "customerName", "receivedAt",
    "subtotalPaise", "deliveryPaise", "deliveryTaxRateBps", "deliveryIncludedTaxPaise", "totalPaise", "includedTaxPaise",
    "warnings", "fulfillmentMethod", "reviewedAt", "reviewedBy", "revision", "createdAt", "updatedAt", "attentionReason", "activeAttemptId", "paidAttemptId", "paidAt"];
  if (details) fields.push("inboundMessageId", "wabaId", "phoneNumberId", "catalogConnectionId", "items", "sourceItems");
  return Object.fromEntries(fields.map((key) => [key, order[key]]).concat([["id", String(order._id)]]));
}
function eventDto(event) {
  return { id: String(event._id), status: event.status, attempts: event.attempts, lastError: event.lastError, createdAt: event.createdAt };
}
module.exports = { EDITABLE, normalizeCart, quoteFromProducts, assertEditable, orderDto, eventDto };
