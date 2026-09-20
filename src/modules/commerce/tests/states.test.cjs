const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ORDER_TRANSITIONS, assertOrderTransition, assertCapturedPayment } = require("../domain/states");

test("order lifecycle requires review, preserves terminal states and allows attention for late payments", () => {
  assert.doesNotThrow(() => assertOrderTransition("needs_details", "needs_review"));
  assert.doesNotThrow(() => assertOrderTransition("needs_review", "awaiting_payment"));
  assert.doesNotThrow(() => assertOrderTransition("awaiting_payment", "confirmed"));
  for (const state of ["cancelled", "completed"]) {
    assert.doesNotThrow(() => assertOrderTransition(state, "requires_attention"));
    assert.throws(() => assertOrderTransition(state, "confirmed"), RangeError);
  }
  assert.throws(() => assertOrderTransition("needs_details", "confirmed"), RangeError);
  assert.throws(() => assertOrderTransition("confirmed", "awaiting_payment"), RangeError);
});
test("state retry is idempotent and unknown/prototype states fail closed", () => {
  for (const state of Object.keys(ORDER_TRANSITIONS)) assert.doesNotThrow(() => assertOrderTransition(state, state));
  for (const state of ["paid", "", "toString", "__proto__", "constructor"]) {
    assert.throws(() => assertOrderTransition(state, state), RangeError);
    assert.throws(() => assertOrderTransition(state, "confirmed"), RangeError);
  }
  assert.equal(Object.isFrozen(ORDER_TRANSITIONS.needs_review), true);
});

function capturedFixture() {
  return {
    attempt: { amountPaise: 11800, currency: "INR", providerLinkId: "plink_test", reference: "checkout_test", providerOrderId: "order_test" },
    payment: { id: "pay_test", order_id: "order_test", status: "captured", captured: true, amount: 11800, currency: "INR" },
    link: { id: "plink_test", order_id: "order_test", reference_id: "checkout_test", amount: 11800, currency: "INR", payments: [{ payment_id: "pay_test" }] },
    expectedAccountId: "acc_test",
    eventAccountId: "acc_test",
  };
}
test("capture correlation accepts matching fetched resources", () => {
  assert.doesNotThrow(() => assertCapturedPayment(capturedFixture()));
});
test("authorization, missing resources, wrong merchant, amounts and provider IDs cannot confirm checkout", () => {
  const cases = [
    (x) => { x.payment.status = "authorized"; },
    (x) => { x.payment.captured = false; },
    (x) => { x.payment.amount = 11801; },
    (x) => { x.payment.currency = "USD"; },
    (x) => { x.payment.order_id = "order_other"; },
    (x) => { x.payment.id = "pay_other"; },
    (x) => { x.link.id = "plink_other"; },
    (x) => { x.link.reference_id = "other"; },
    (x) => { x.link.amount = 11799; },
    (x) => { x.link.currency = "USD"; },
    (x) => { x.link.order_id = "order_other"; },
    (x) => { x.link.payments = null; },
    (x) => { x.link = null; },
    (x) => { x.payment = null; },
    (x) => { x.attempt = null; },
    (x) => { x.attempt.amountPaise = 0; },
    (x) => { x.attempt.providerOrderId = "order_other"; },
    (x) => { x.attempt.providerLinkId = ""; },
    (x) => { x.eventAccountId = "acc_other"; },
  ];
  for (const mutate of cases) {
    const fixture = capturedFixture();
    mutate(fixture);
    assert.throws(() => assertCapturedPayment(fixture), RangeError);
  }
});

