require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, ws, otherWs, gatewayId, userId } = require("./payments-fixture.cjs");
test("reviewed checkout freezes the quote, reserves stock and uses only the merchant connection", async (t) => {
  const f = await fixture(t), input = f.input(), a = await f.checkout();
  assert.equal(a.status, "payable"); assert.equal(a.amountPaise, 2400); assert.equal(a.paymentUrl, "https://rzp.io/i/test");
  assert.equal(f.state.products[0].stockReserved, 3); assert.equal(f.state.products[0].stockOnHand, 10);
  assert.equal(f.state.orders[0].status, "awaiting_payment"); assert.equal(f.state.reservations[0].status, "held");
  assert.deepEqual(f.calls.newAuth[0], [ws, gatewayId, "test"]);
  const duplicate = await f.service.checkout(ws, f.state.orders[0]._id, userId, input);
  assert.equal(duplicate.id, a.id); assert.equal(f.calls.create, 1); assert.equal(f.state.attempts.length, 1);
  await assert.rejects(f.service.checkout(ws, f.state.orders[0]._id, userId, { ...input, revision: input.revision + 1 }), /changed/);
});
test("checkout denies tenant, stale review, client totals, stock shortage and live readiness before POST", async (t) => {
  const f = await fixture(t), input = f.input();
  await assert.rejects(f.service.checkout(otherWs, f.state.orders[0]._id, userId, input), /not found/);
  await assert.rejects(f.service.checkout(ws, f.state.orders[0]._id, userId, { ...input, amountPaise: 1 }));
  f.state.products[0] = { ...f.state.products[0], revision: 99 };
  await assert.rejects(f.checkout(), /fresh merchant review/); assert.equal(f.state.attempts.length, 0);
  f.state.products[0] = { ...f.state.products[0], revision: 2, stockOnHand: 2 };
  await assert.rejects(f.checkout());
  f.state.products[0] = { ...f.state.products[0], stockOnHand: 10 };
  f.state.orders[0] = { ...f.state.orders[0], environment: "live" };
  f.state.gateways[0] = { ...f.state.gateways[0], environment: "live" };
  f.flags.live = true; f.state.settings.liveCheckoutEnabled = true;
  f.state.gateways[0].webhookSecretEnc = "";
  await assert.rejects(f.checkout(), /payment webhook/); assert.equal(f.calls.create, 0);
});

test("live manual keys create and reconcile hosted payments without OAuth identity or prior webhook events", async (t) => {
  const f = await fixture(t);
  f.state.orders[0].environment = "live"; f.state.gateways[0].environment = "live";
  f.flags.live = true; f.state.settings.liveCheckoutEnabled = true;
  const attempt = await f.checkout();
  assert.equal(attempt.status, "payable"); assert.equal(f.calls.create, 1);
  assert.equal(f.state.gateways[0].identityVerified, false);
  assert.equal(f.state.gateways[0].webhookStatus, "needs_setup");
  assert.deepEqual(f.calls.newAuth[0], [ws, gatewayId, "live"]);
  f.pay(); await f.recovery.reconcile(ws, attempt.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured");
});

test("live manual hosted checkout still requires both live gates", async (t) => {
  const f = await fixture(t); f.state.orders[0].environment = "live"; f.state.gateways[0].environment = "live";
  f.state.settings.liveCheckoutEnabled = true;
  await assert.rejects(f.checkout(), /Enable live checkout/);
  f.flags.live = true; f.state.settings.liveCheckoutEnabled = false;
  await assert.rejects(f.checkout(), /Enable live checkout/); assert.equal(f.calls.create, 0);
});

test("manual hosted policy does not bypass native identity, OAuth verification or credential readiness", () => {
  const { liveGatewayReady } = require("../domain/liveGateway");
  const g = { active: true, status: "connected", environment: "live", authType: "api_keys", credentialsVerifiedAt: new Date(), webhookSecretEnc: "encrypted", webhookStatus: "needs_setup", identityVerified: false };
  assert.equal(liveGatewayReady(g, "razorpay_payment_link"), true);
  assert.equal(liveGatewayReady(g, "whatsapp_native"), false);
  for (const patch of [{ active: false }, { environment: "test" }, { credentialsVerifiedAt: null }, { webhookSecretEnc: "" }, { status: "revoked" }, { authType: "oauth" }, { webhookStatus: "failed" }]) assert.equal(liveGatewayReady({ ...g, ...patch }, "razorpay_payment_link"), false);
  assert.equal(liveGatewayReady({ ...g, authType: "oauth", identityVerified: true, merchantAccountId: "acc_verified", webhookStatus: "verified" }, "razorpay_payment_link"), true);
});
test("gateway fencing failure rolls back the entire stock reservation and checkout", async (t) => {
  const f = await fixture(t); f.repo.fenceGateway = async () => null;
  await assert.rejects(f.checkout());
  assert.equal(f.state.products[0].stockReserved, 1); assert.equal(f.state.attempts.length, 0);
  assert.equal(f.state.reservations.length, 0); assert.equal(f.state.orders[0].status, "needs_review");
});
test("concurrent checkout clicks produce one attempt and one provider POST", async (t) => {
  const f = await fixture(t), input = f.input(), id = f.state.orders[0]._id;
  const results = await Promise.all([f.service.checkout(ws, id, userId, input), f.service.checkout(ws, id, userId, input)]);
  assert.equal(results[0].id, results[1].id); assert.equal(f.state.attempts.length, 1); assert.equal(f.calls.create, 1);
});
test("timeout after successful POST recovers by reference without another POST", async (t) => {
  const f = await fixture(t), create = f.provider.createLink;
  f.provider.createLink = async (...args) => { await create(...args); throw new Error("network response lost"); };
  const a = await f.checkout(); assert.equal(a.status, "unknown"); assert.equal(a.paymentUrl, "");
  await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.attempts[0].status, "payable"); assert.equal(f.calls.create, 1); assert.equal(f.state.products[0].stockReserved, 3);
});
test("unresolved create remains blocked after stock expiry and cannot create a replacement", async (t) => {
  const f = await fixture(t); f.provider.createLink = async () => { f.calls.create++; throw new Error("timeout"); };
  const a = await f.checkout(); f.advance(31 * 60000);
  await assert.rejects(f.recovery.reconcile(ws, a.id));
  assert.equal(f.state.reservations[0].status, "released"); assert.equal(f.state.products[0].stockReserved, 1);
  assert.equal(f.state.attempts[0].active, true); assert.equal(f.state.orders[0].status, "requires_attention");
  await assert.rejects(f.service.checkout(ws, f.state.orders[0]._id, userId, { ...f.input(), idempotencyKey: "replacement_key_02" }));
  assert.equal(f.calls.create, 1);
});
test("captured payment atomically consumes stock once and creates one durable confirmation", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay();
  await f.recovery.reconcile(ws, a.id); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.payments.length, 1); assert.equal(f.state.payments[0].capturedAt, null);
  assert.equal(f.state.products[0].stockOnHand, 8); assert.equal(f.state.products[0].stockReserved, 1);
  assert.equal(f.state.reservations[0].status, "consumed"); assert.equal(f.state.orders[0].status, "confirmed");
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.notifications.length, 1);
  assert.equal((await f.service.getAttempt(ws, a.id)).paymentUrl, "");
});
test("authorized, wrong amount, wrong currency and wrong order cannot confirm payment", async (t) => {
  for (const patch of [{ status: "authorized", captured: false }, { amount: 1 }, { currency: "USD" }, { order_id: "order_Other" }]) {
    const f = await fixture(t), a = await f.checkout(); f.pay();
    f.state.providerPayments[0] = { ...f.state.providerPayments[0], ...patch };
    await assert.rejects(f.recovery.reconcile(ws, a.id));
    assert.equal(f.state.payments.length, 0); assert.equal(f.state.orders[0].paymentStatus, "pending");
    assert.equal(f.state.products[0].stockOnHand, 10);
  }
});
test("capture commit failure rolls back payment, reservation, order and outbox then retries safely", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay();
  const outbox = f.repo.outbox; f.repo.outbox = async () => { throw new Error("database unavailable"); };
  await assert.rejects(f.recovery.reconcile(ws, a.id));
  assert.equal(f.state.payments.length, 0); assert.equal(f.state.products[0].stockOnHand, 10); assert.equal(f.state.reservations[0].status, "held");
  f.repo.outbox = outbox; await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.payments.length, 1); assert.equal(f.state.products[0].stockOnHand, 8);
});
test("expiry racing capture either consumes a held reservation or records paid attention without double stock changes", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.advance(31 * 60000); f.pay();
  await Promise.all([f.recovery.expireReservation(ws, a.id), f.recovery.reconcile(ws, a.id)]);
  assert.equal(f.state.payments.length, 1); assert.equal(f.state.orders[0].paymentStatus, "captured");
  assert.equal(f.state.products[0].stockReserved, 1);
  const released = f.state.reservations[0].status === "released";
  assert.equal(f.state.products[0].stockOnHand, released ? 10 : 8);
  assert.equal(f.state.orders[0].status, released ? "requires_attention" : "confirmed");
});
test("cancel hides URL immediately and releases only after provider terminal verification", async (t) => {
  const f = await fixture(t), a = await f.checkout();
  const result = await f.service.cancel(ws, a.id);
  assert.equal(result.paymentUrl, ""); assert.equal(f.calls.cancel, 1); assert.equal(f.state.reservations[0].status, "held");
  await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.reservations[0].status, "released"); assert.equal(f.state.orders[0].status, "needs_review");
  assert.equal(f.state.orders[0].reviewedAt, null); assert.equal(f.state.attempts[0].active, false);
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.products[0].stockReserved, 1);
});
test("late capture after verified expiry stays paid and requires fulfillment review", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.advance(31 * 60000);
  f.state.providerLinks[0] = { ...f.state.providerLinks[0], status: "expired" };
  await f.recovery.reconcile(ws, a.id); f.pay(); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.orders[0].attentionReason, "payment_after_stock_release");
  assert.equal(f.state.products[0].stockOnHand, 10); assert.equal(f.state.products[0].stockReserved, 1);
});
test("extra captured payments are recorded independently and do not consume inventory again", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  f.pay(f.state.attempts[0], "pay_Extra2"); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.payments.length, 2); assert.equal(f.state.payments[1].overpayment, true);
  assert.equal(f.state.orders[0].attentionReason, "extra_captured_payment_refund_review"); assert.equal(f.state.products[0].stockOnHand, 8);
  assert.equal(f.state.notifications.length, 1);
});
test("recovery uses the historical merchant after local disconnect and survives new-checkout rollback", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); f.flags.checkout = false;
  f.state.gateways[0] = { ...f.state.gateways[0], active: false, status: "disconnected" };
  await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.deepEqual(f.calls.readAuth.at(-1), [ws, gatewayId, "test"]);
});
test("verified payment is never downgraded by stale provider state", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  f.state.providerLinks[0] = { ...f.state.providerLinks[0], status: "expired", payments: [], amount_paid: 0 };
  await assert.rejects(f.recovery.reconcile(ws, a.id));
  assert.equal(f.state.attempts[0].status, "captured"); assert.equal(f.state.orders[0].paymentStatus, "captured");
});
test("dashboard partial/full refunds sync monotonically and never restock or rewrite paid state", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  f.state.providerRefunds = [{ id: "rfnd_Test1", payment_id: "pay_Test1", currency: "INR", amount: 500, status: "processed" }];
  f.state.providerPayments[0] = { ...f.state.providerPayments[0], amount_refunded: 500 };
  await f.recovery.syncRefunds(ws, f.state.payments[0]._id);
  f.state.providerRefunds[0] = { ...f.state.providerRefunds[0], status: "pending" };
  f.state.providerPayments[0] = { ...f.state.providerPayments[0], amount_refunded: 0 };
  await f.recovery.syncRefunds(ws, f.state.payments[0]._id);
  assert.equal(f.state.payments[0].refundedPaise, 500); assert.equal(f.state.refunds[0].status, "processed");
  f.state.providerRefunds.push({ id: "rfnd_Test2", payment_id: "pay_Test1", currency: "INR", amount: 1900, status: "processed" });
  f.state.providerPayments[0] = { ...f.state.providerPayments[0], status: "refunded", amount_refunded: 2400 };
  await f.recovery.syncRefunds(ws, f.state.payments[0]._id); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.payments[0].refundedPaise, 2400); assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.products[0].stockOnHand, 8);
});
test("foreign or wrong-amount refunds cannot modify verified records", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  f.state.providerRefunds = [{ id: "rfnd_Bad1", payment_id: "pay_Other", currency: "INR", amount: 500, status: "processed" }];
  await assert.rejects(f.recovery.syncRefunds(ws, f.state.payments[0]._id, "rfnd_Bad1"));
  await assert.rejects(f.recovery.syncRefunds(otherWs, f.state.payments[0]._id));
  assert.equal(f.state.refunds.length, 0); assert.equal(f.state.payments[0].refundedPaise, 0);
});
test("payment lists separate environment and never expose gateway secrets", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  assert.equal((await f.service.list(ws, { environment: "test" })).items.length, 1);
  assert.equal((await f.service.list(ws, { environment: "live" })).items.length, 0);
  assert.equal((await f.service.list(otherWs, { environment: "test" })).items.length, 0);
  assert.equal(JSON.stringify(await f.service.getAttempt(ws, a.id)).includes("leaseOwner"), false);
});
test("two reviewed carts competing for the last available quantity cannot both reserve stock", async (t) => {
  const f = await fixture(t), mongoose = require("mongoose");
  f.state.products[0] = { ...f.state.products[0], stockOnHand: 3 };
  const second = { ...f.state.orders[0], _id: new mongoose.Types.ObjectId(), orderNumber: "second-order", inboundMessageId: "wamid.second" };
  f.state.orders.push(second);
  const firstInput = f.input();
  const results = await Promise.allSettled([f.service.checkout(ws, f.state.orders[0]._id, userId, firstInput),
    f.service.checkout(ws, second._id, userId, { ...firstInput, idempotencyKey: "second_checkout_02" })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.state.attempts.length, 1);
  assert.equal(f.state.products[0].stockReserved, 3); assert.equal(f.calls.create, 1);
});
test("capture racing provider cancellation wins payment verification on the following reconciliation", async (t) => {
  const f = await fixture(t), a = await f.checkout();
  f.provider.cancelLink = async () => { f.pay(); return { status: "cancelled" }; };
  await f.service.cancel(ws, a.id); assert.equal(f.state.orders[0].paymentStatus, "pending");
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.reservations[0].status, "consumed");
});
test("a refund seen before the first capture verification requires fulfillment review", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay();
  f.state.providerPayments[0] = { ...f.state.providerPayments[0], status: "refunded", amount_refunded: 2400 };
  await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.orders[0].status, "requires_attention");
  assert.equal(f.state.orders[0].attentionReason, "payment_refunded_review"); assert.equal(f.state.payments[0].refundedPaise, 2400);
});
test("multiple capture records reconcile in bounded batches without losing extra payments", async (t) => {
  const f = await fixture(t), a = await f.checkout();
  for (let i = 1; i <= 11; i++) f.pay(f.state.attempts[0], `pay_Extra${i}`);
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.payments.length, 10); assert.equal(f.state.attempts[0].captureCursor, 10);
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.payments.length, 11); assert.equal(f.state.attempts[0].captureCursor, 0);
  assert.equal(f.state.payments.filter((p) => p.overpayment).length, 10); assert.equal(f.state.products[0].stockOnHand, 8);
});
test("late capture from an expired attempt requests cancellation and releases a replacement reservation", async (t) => {
  const f = await fixture(t), first = await f.checkout(); f.advance(31 * 60000);
  f.state.providerLinks[0] = { ...f.state.providerLinks[0], status: "expired" }; await f.recovery.reconcile(ws, first.id);
  const orders = require("../services/orders.service").createOrdersService({ repo: f.repo, now: f.now });
  const order = f.state.orders[0], quote = await orders.quote(ws, order._id);
  await orders.review(ws, order._id, userId, { revision: order.revision, expectedTotalPaise: quote.totalPaise, productRevisions: quote.productRevisions, acknowledgeWarnings: true });
  const second = await f.service.checkout(ws, order._id, userId, { ...f.input(), idempotencyKey: "replacement_checkout_02" });
  assert.equal(f.state.products[0].stockReserved, 3);
  f.pay(f.state.attempts[0], "pay_Late1"); await f.recovery.reconcile(ws, first.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.orders[0].attentionReason, "payment_after_stock_release");
  assert.ok(f.state.attempts[1].cancelRequestedAt); assert.equal(f.state.reservations[1].status, "released");
  assert.equal((await f.service.getAttempt(ws, second.id)).paymentUrl, "");
  await f.recovery.reconcile(ws, second.id); await f.recovery.reconcile(ws, second.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.orders[0].activeAttemptId, null);
  assert.equal(f.state.products[0].stockReserved, 1); assert.equal(f.state.products[0].stockOnHand, 10);
});
