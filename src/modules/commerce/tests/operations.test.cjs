require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, ws, otherWs, userId } = require("./payments-fixture.cjs");
const { createOperationsService } = require("../services/operations.service");
const { assertFulfillment, nextStatus } = require("../domain/fulfillment");
const { decryptCommerceSecret } = require("../services/commerceSecrets.service");
const { createPaymentOutbox } = require("../services/paymentOutbox.service");
const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { oauthReturnUrl } = require("../domain/oauthReturn");
async function operations(t, paid = true) {
  const f = await fixture(t); await f.checkout();
  if (paid) { f.pay(); await f.recovery.reconcile(ws, f.state.attempts[0]._id); }
  Object.assign(f.repo, {
    hasPaymentIssue: async (workspace, id) => f.state.payments.some((p) => String(p.workspaceId) === workspace && String(p.orderId) === String(id) && (p.refundedPaise > 0 || p.overpayment)),
    allocateStock: async (workspace, item) => { const p = f.state.products.find((p) => String(p.workspaceId) === workspace && String(p._id) === String(item.productId));
      return p && p.trackInventory && p.available && !p.archivedAt && p.stockOnHand - p.stockReserved >= item.quantity
        ? f.update("products", p, { stockOnHand: p.stockOnHand - item.quantity, revision: p.revision + 1 }) : null; },
    allocateReservation: async (record) => record.status === "released" ? f.update("reservations", record, { status: "consumed" }) : null,
    notification: async (workspace, id) => f.state.notifications.find((n) => String(n.workspaceId) === workspace && String(n._id) === String(id)),
    retryNotification: async (record, payloadEnc) => {
      const fresh = f.state.notifications.find((n) => String(n._id) === String(record._id));
      return fresh?.status === "blocked" ? f.update("notifications", fresh, { status: "pending", startedAt: null, payloadEnc }) : null;
    },
  });
  return { ...f, operations: createOperationsService({ repo: f.repo, now: f.now, authorize: async () => {} }) };
}
test("paid pickup and delivery advance only through their permitted fulfillment sequence", async (t) => {
  const f = await operations(t), before = f.state.products[0].stockOnHand;
  for (const status of ["processing", "ready", "completed"]) {
    const order = f.state.orders[0]; const result = await f.operations.fulfill(ws, order._id, { revision: order.revision, status });
    assert.equal(result.status, status); assert.equal(result.paymentStatus, "captured");
  }
  assert.equal(f.state.products[0].stockOnHand, before);
  assert.equal(nextStatus({ status: "processing", fulfillmentMethod: "delivery" }), "out_for_delivery");
  assert.equal(nextStatus({ status: "ready", fulfillmentMethod: "delivery" }), null);
  assert.equal(nextStatus({ status: "out_for_delivery", fulfillmentMethod: "delivery" }), "completed");
});

test("manual delivery cannot bypass PIN completion through legacy order fulfillment", async (t) => {
  const f = await operations(t), order = f.state.orders[0]; order.manualDeliveryId = "500000000000000000000001";
  await assert.rejects(f.operations.fulfill(ws, order._id, { revision: order.revision, status: "processing" }), /delivery workflow/);
  assert.equal(f.state.orders[0].status, "confirmed");
});
test("native fulfillment persists a status notification with the same transaction and original payment reference", async (t) => {
  const f = await operations(t), attempt = f.state.attempts[0];
  f.update("attempts", attempt, { mode: "whatsapp_native", nativeWabaId: "123", nativePhoneNumberId: "456" });
  let order = f.state.orders[0];
  await f.operations.fulfill(ws, order._id, { revision: order.revision, status: "processing" }, userId);
  assert.equal(f.state.notifications.length, 2);
  const statusRecord = f.state.notifications[1]; assert.equal(statusRecord.requestedBy, userId);
  await f.outbox.run();
  const parameters = JSON.parse(f.calls.lastMessage.commerceContent.interactive.action.parameters);
  assert.equal(parameters.reference_id, attempt.reference); assert.equal(parameters.order.status, "processing");
  assert.equal(f.calls.lastMessage.commerceContent.metadata.orderId, String(order._id));
  order = f.state.orders[0]; await f.operations.fulfill(ws, order._id, { revision: order.revision, status: "ready" }, userId);
  order = f.state.orders[0]; const original = f.repo.outbox; f.repo.outbox = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(f.operations.fulfill(ws, order._id, { revision: order.revision, status: "completed" }, userId), /storage unavailable/);
  assert.equal(f.state.orders[0].status, "ready"); f.repo.outbox = original;
});
test("fulfillment rejects foreign tenants, stale revisions, unpaid orders and skipped steps", async (t) => {
  const f = await operations(t), order = f.state.orders[0], input = { revision: order.revision, status: "processing" };
  await assert.rejects(f.operations.fulfill(otherWs, order._id, input), /not found/);
  await assert.rejects(f.operations.fulfill(ws, order._id, { ...input, revision: 1 }), /changed/);
  await assert.rejects(f.operations.fulfill(ws, order._id, { ...input, status: "completed" }), /transition/);
  for (const patch of [{ paymentStatus: "unpaid" }, { paidAttemptId: null }, { activeAttemptId: "active" }])
    assert.throws(() => assertFulfillment({ ...order, ...patch }, input), /verification/);
  const outcomes = await Promise.allSettled([f.operations.fulfill(ws, order._id, input), f.operations.fulfill(ws, order._id, input)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
});
test("refunded and extra payments block fulfillment without changing stock", async (t) => {
  const f = await operations(t), order = f.state.orders[0];
  f.update("payments", f.state.payments[0], { refundedPaise: 1 });
  await assert.rejects(f.operations.fulfill(ws, order._id, { revision: order.revision, status: "processing" }), /refund or extra/);
  f.update("payments", f.state.payments[0], { refundedPaise: 0, overpayment: true });
  await assert.rejects(f.operations.fulfill(ws, order._id, { revision: order.revision, status: "processing" }), /refund or extra/);
  assert.equal(f.state.orders[0].status, "confirmed");
});
test("late paid order needs explicit stock allocation; transaction rolls back a failed final write", async (t) => {
  const f = await operations(t), order = f.state.orders[0];
  f.update("orders", order, { status: "requires_attention", attentionReason: "payment_after_stock_release" });
  f.update("reservations", f.state.reservations[0], { status: "released" });
  f.update("products", f.state.products[0], { stockOnHand: 10 });
  const input = { revision: order.revision, status: "confirmed", acknowledgeAttention: true };
  await assert.rejects(f.operations.fulfill(ws, order._id, { ...input, acknowledgeAttention: false }), /transition/);
  const transition = f.repo.transitionOrder; f.repo.transitionOrder = async () => null;
  await assert.rejects(f.operations.fulfill(ws, order._id, input), /changed/);
  assert.equal(f.state.products[0].stockOnHand, 10); assert.equal(f.state.reservations[0].status, "released");
  f.repo.transitionOrder = transition;
  const outcomes = await Promise.allSettled([f.operations.fulfill(ws, order._id, input), f.operations.fulfill(ws, order._id, input)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.state.products[0].stockOnHand, 8); assert.equal(f.state.reservations[0].status, "consumed");
});
test("late allocation shortage preserves paid attention and released reservation", async (t) => {
  const f = await operations(t), order = f.state.orders[0];
  f.update("orders", order, { status: "requires_attention", attentionReason: "payment_after_stock_release" });
  f.update("reservations", f.state.reservations[0], { status: "released" }); f.update("products", f.state.products[0], { stockOnHand: 2 });
  await assert.rejects(f.operations.fulfill(ws, order._id, { revision: order.revision, status: "confirmed", acknowledgeAttention: true }), /not enough/);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.products[0].stockOnHand, 2);
});
test("blocked confirmation retry is tenant scoped, reauthorizes sender and cannot retry unknown dispatch", async (t) => {
  const f = await operations(t), record = f.state.notifications[0];
  f.update("notifications", record, { status: "unknown" });
  await assert.rejects(f.operations.retryNotification(ws, record._id, userId), /Only a notification blocked/);
  await assert.rejects(f.operations.retryNotification(otherWs, record._id, userId), /not found/);
  f.update("notifications", record, { status: "blocked" });
  const forbidden = createOperationsService({ repo: f.repo, authorize: async () => { throw new Error("denied"); } });
  await assert.rejects(forbidden.retryNotification(ws, record._id, userId), /denied/);
  await f.operations.retryNotification(ws, record._id, userId);
  const saved = f.state.notifications[0]; assert.equal(saved.status, "pending");
  assert.equal(JSON.parse(decryptCommerceSecret(saved.payloadEnc, { workspaceId: ws, recordId: record._id, field: "payloadEnc" })).authorizedBy, userId);
  await assert.rejects(f.operations.retryNotification(ws, record._id, userId), /Only a notification blocked/);
});
test("real Commerce permission allows the confirmation worker and revoked membership blocks it", async (t) => {
  const f = await operations(t); let allowed = true;
  t.mock.method(Workspace, "findOne", async () => ({ _id: ws, ownerId: "other", isActive: true, status: "active" }));
  t.mock.method(WorkspaceMember, "findOne", async () => allowed ? { role: "agent", permissionsOverride: {} } : null);
  const outbox = createPaymentOutbox({ repo: f.repo, config: f.config, now: f.now, send: f.send });
  assert.equal((await outbox.run()).sent, 1); assert.equal(f.calls.send, 1);
  f.update("notifications", f.state.notifications[0], { status: "pending" }); allowed = false;
  assert.equal((await outbox.run()).deferred, 1); assert.equal(f.calls.send, 1);
});
test("OAuth browser return uses only configured safe origins and omits credentials and provider data", () => {
  assert.equal(oauthReturnUrl({ cancelled: false, code: "secret" }, "https://app.example.com/path"), "https://app.example.com/app/commerce/settings?oauth=connected");
  assert.equal(oauthReturnUrl({ cancelled: true }, "https://app.example.com"), "https://app.example.com/app/commerce/settings?oauth=cancelled");
  for (const base of ["javascript:alert(1)", "https://user:password@example.com", "http://example.com", "invalid"]) assert.equal(oauthReturnUrl({}, base), null);
});
