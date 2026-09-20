require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCart, quoteFromProducts, assertEditable, orderDto } = require("../domain/orders");
const v = require("../validators/orders.validators");
const message = () => ({ id: "wamid.example", from: "919999999999", timestamp: "1789041600", type: "order",
  order: { catalog_id: "123", product_items: [{ product_retailer_id: "tea", quantity: "2", item_price: "10.50", currency: "INR" }] } });
const product = () => ({ _id: "300000000000000000000001", sku: "tea", name: "Tea", revision: 3, pricePaise: 1200,
  available: true, taxConfirmed: true, taxRateBps: null, trackInventory: true, stockOnHand: 10, stockReserved: 1 });
test("cart normalization accepts whole string/number quantities and decimal prices without trusting them for quotes", () => {
  const cart = normalizeCart(message()); assert.equal(cart.items[0].quantity, 2); assert.equal(cart.items[0].unitPricePaise, 1050);
  const numeric = message(); numeric.order.product_items[0].quantity = 2; numeric.order.product_items[0].item_price = 10.5;
  assert.deepEqual(normalizeCart(numeric).items, cart.items);
  const quote = quoteFromProducts(cart.items, [product()], 0, null, cart.items);
  assert.equal(quote.totalPaise, 2400); assert.deepEqual(quote.warnings, ["price_changed:tea"]); assert.equal(quote.includedTaxPaise, null);
});
test("malformed carts reject fractional/zero/excessive quantities, duplicate SKUs and non-INR items", () => {
  for (const quantity of [0, -1, 1.5, "1.5", "1e2", " 2", "02", true, 10001, null]) {
    const m = message(); m.order.product_items[0].quantity = quantity;
    assert.throws(() => normalizeCart(m), { commerceCode: "invalid_quantity" });
  }
  const duplicate = message(); duplicate.order.product_items.push({ ...duplicate.order.product_items[0] });
  assert.throws(() => normalizeCart(duplicate), { commerceCode: "invalid_or_duplicate_sku" });
  const wrongCurrency = message(); wrongCurrency.order.product_items[0].currency = "USD";
  assert.throws(() => normalizeCart(wrongCurrency), { commerceCode: "unsupported_currency" });
  const badPrice = message(); badPrice.order.product_items[0].item_price = "1.005";
  assert.throws(() => normalizeCart(badPrice), { commerceCode: "invalid_source_price" });
});
test("missing products cannot generate fabricated line items; unavailable products remain review blockers", () => {
  const cart = normalizeCart(message());
  assert.throws(() => quoteFromProducts(cart.items, []), { commerceCode: "unknown_product" });
  const p = { ...product(), available: false, taxConfirmed: false, stockOnHand: 1 };
  const result = quoteFromProducts(cart.items, [p]);
  assert.deepEqual(result.blockers, ["unavailable:tea", "tax_unconfirmed:tea", "insufficient_stock:tea"]);
  assert.equal(p.stockReserved, 1);
});
test("review APIs reject client ownership/payment fields and fulfillment rejects arbitrary address data", () => {
  const input = { revision: 1, fulfillmentMethod: "pickup", deliveryPrice: "0", deliveryTaxRateBps: null };
  assert.deepEqual(v.parse(v.edit, input), input);
  for (const field of ["workspaceId", "status", "paymentStatus", "reviewedAt", "environment", "unitPricePaise"])
    assert.throws(() => v.parse(v.edit, { ...input, [field]: "untrusted" }), { statusCode: 400 });
  assert.throws(() => v.parse(v.fulfillment, { fulfillmentMethod: "delivery", address: {} }), { statusCode: 400 });
  assert.throws(() => v.parse(v.fulfillment, { fulfillmentMethod: "pickup", deliveryPrice: "10" }), { statusCode: 400 });
  assert.throws(() => v.parse(v.list, {}), { statusCode: 400 });
  assert.throws(() => v.parse(v.settings, { revision: 0, enabled: true, pickupEnabled: false, deliveryEnabled: false,
    pickupInstructions: "", testRecipients: [] }), { statusCode: 400 });
});
test("paid or active checkout orders are immutable to Stage 4 edits", () => {
  const order = { status: "needs_review", paymentStatus: "unpaid", activeAttemptId: null, paidAttemptId: null };
  assert.doesNotThrow(() => assertEditable(order));
  for (const patch of [{ status: "awaiting_payment" }, { status: "confirmed" }, { paymentStatus: "captured" }, { activeAttemptId: "attempt" }, { paidAttemptId: "paid" }])
    assert.throws(() => assertEditable({ ...order, ...patch }), { statusCode: 409 });
});
test("order DTO excludes encrypted addresses/notes, raw event and future secret fields", () => {
  const order = { _id: "one", status: "needs_review", addressEnc: "sensitive", customerNoteEnc: "sensitive", payloadEnc: "sensitive", futureSecret: "sensitive" };
  assert.equal(JSON.stringify(orderDto(order, true)).includes("sensitive"), false);
});
