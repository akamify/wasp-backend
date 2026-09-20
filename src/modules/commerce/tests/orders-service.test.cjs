const { test } = require("node:test");
const assert = require("node:assert/strict");
const { fixture, ws, otherWs, address } = require("./orders-fixture.cjs");
test("merchant review requires fulfillment and the freshly previewed price/product revisions", async (t) => {
  const f = fixture(t); let order = await f.create(); let quote = await f.service.quote(ws, order.id);
  await assert.rejects(f.service.review(ws, order.id, "merchant", f.reviewInput(order, quote)), { statusCode: 409 });
  order = await f.editPickup(order); quote = await f.service.quote(ws, order.id);
  f.state.products[0].pricePaise = 1400; f.state.products[0].revision++;
  await assert.rejects(f.service.review(ws, order.id, "merchant", f.reviewInput(order, quote)), { statusCode: 409 });
  quote = await f.service.quote(ws, order.id);
  const reviewed = await f.service.review(ws, order.id, "merchant", f.reviewInput(order, quote));
  assert.equal(reviewed.totalPaise, 2800); assert.equal(reviewed.reviewedBy, "merchant"); assert.ok(reviewed.reviewedAt);
  assert.equal(reviewed.status, "needs_review"); assert.equal(reviewed.paymentStatus, "unpaid"); assert.equal(f.state.products[0].stockReserved, 1);
});

test("switching an accepted unpaid delivery to pickup closes its sidecar in the same transaction", async (t) => {
  const f = fixture(t), created = await f.create(), calls = [];
  f.state.orders[0].manualDeliveryId = "500000000000000000000001";
  t.mock.method(require("../delivery/service"), "rejectPending", async (order, session, kind) => { calls.push({ order, session, kind }); });
  const updated = await f.editPickup(created);
  assert.equal(updated.manualDeliveryId, null); assert.equal(calls[0].kind, "fulfillment_changed"); assert.ok(calls[0].session.testTransaction);
});
test("insufficient stock and unconfirmed tax prevent approval while leaving the cart visible", async (t) => {
  const f = fixture(t); const order = await f.editPickup(await f.create());
  f.state.products[0].stockOnHand = 1; f.state.products[0].taxConfirmed = false;
  const quote = await f.service.quote(ws, order.id); assert.equal(quote.blockers.length, 2);
  await assert.rejects(f.service.review(ws, order.id, "merchant", f.reviewInput(order, quote)), { statusCode: 409 });
  assert.equal((await f.service.get(ws, order.id)).reviewedAt, null);
});
test("delivery edits encrypt addresses, preserve unknown tax and clear any prior review", async (t) => {
  const f = fixture(t); let order = await f.editPickup(await f.create());
  order = await f.service.review(ws, order.id, "merchant", f.reviewInput(order, await f.service.quote(ws, order.id)));
  const edited = await f.service.edit(ws, order.id, { revision: order.revision, fulfillmentMethod: "delivery", address,
    deliveryPrice: "20.50", deliveryTaxRateBps: null, items: [{ sku: "tea", quantity: 1 }] });
  assert.equal(edited.totalPaise, 3250); assert.equal(edited.includedTaxPaise, null); assert.equal(edited.reviewedAt, null);
  assert.equal(edited.address.line1, address.line1); assert.equal(f.state.orders[0].addressEnc.includes(address.line1), false);
  assert.equal(f.state.orders[0].sourceItems[0].quantity, 2);
});
test("tenant and revision checks reject foreign IDs and concurrent stale edits", async (t) => {
  const f = fixture(t); const order = await f.create();
  await assert.rejects(f.service.get(otherWs, order.id), { statusCode: 404 });
  const results = await Promise.allSettled([f.editPickup(order), f.editPickup(order)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 409);
});
test("cancellation is local and cannot cancel active/paid checkout orders", async (t) => {
  const f = fixture(t); const order = await f.create();
  f.state.orders[0].activeAttemptId = "500000000000000000000001";
  await assert.rejects(f.service.cancel(ws, order.id, { revision: order.revision }), { statusCode: 409 });
  f.state.orders[0].activeAttemptId = null;
  const cancelled = await f.service.cancel(ws, order.id, { revision: order.revision }); assert.equal(cancelled.status, "cancelled");
  assert.equal((await f.service.cancel(ws, order.id, { revision: cancelled.revision })).revision, cancelled.revision);
});
test("public fulfillment session discloses no personal data and consumes atomically with encrypted details", async (t) => {
  const f = fixture(t); const order = await f.create();
  const session = await f.service.createFulfillmentSession(ws, order.id, "merchant", { revision: order.revision });
  const view = await f.service.getFulfillment(session.token);
  assert.equal(JSON.stringify(view).includes("919999999999"), false); assert.equal(view.orderNumber, order.orderNumber);
  assert.equal(f.state.sessions[0].tokenHash.includes(session.token), false);
  const result = await f.service.submitFulfillment(session.token, { fulfillmentMethod: "delivery", address });
  assert.equal(result.status, "needs_review"); assert.ok(f.state.sessions[0].usedAt);
  assert.equal((await f.service.get(ws, order.id)).address.line1, address.line1);
  await assert.rejects(f.service.submitFulfillment(session.token, { fulfillmentMethod: "pickup" }), { statusCode: 410 });
});
test("expired/superseded fulfillment sessions fail independently of TTL cleanup", async (t) => {
  const f = fixture(t); const order = await f.create();
  const old = await f.service.createFulfillmentSession(ws, order.id, "merchant", { revision: order.revision });
  f.advance(30 * 60000); await assert.rejects(f.service.getFulfillment(old.token), { statusCode: 410 });
  const current = await f.service.createFulfillmentSession(ws, order.id, "merchant", { revision: order.revision });
  await f.editPickup(order); await assert.rejects(f.service.getFulfillment(current.token), { statusCode: 410 });
});
test("two simultaneous public submissions cannot update the order twice", async (t) => {
  const f = fixture(t); const order = await f.create();
  const session = await f.service.createFulfillmentSession(ws, order.id, "merchant", { revision: order.revision });
  const results = await Promise.allSettled([f.service.submitFulfillment(session.token, { fulfillmentMethod: "pickup" }),
    f.service.submitFulfillment(session.token, { fulfillmentMethod: "pickup" })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.state.orders[0].revision, order.revision + 1);
});
test("failed fulfillment order write rolls back token consumption and permits a safe retry", async (t) => {
  const f = fixture(t); const order = await f.create();
  const session = await f.service.createFulfillmentSession(ws, order.id, "merchant", { revision: order.revision });
  const update = f.repo.updateOrder; f.repo.updateOrder = async () => null;
  await assert.rejects(f.service.submitFulfillment(session.token, { fulfillmentMethod: "pickup" }), { statusCode: 409 });
  assert.equal(f.state.sessions[0].usedAt, null);
  f.repo.updateOrder = update; await f.service.submitFulfillment(session.token, { fulfillmentMethod: "pickup" });
  assert.ok(f.state.sessions[0].usedAt);
});
test("order listing is environment-scoped, paginated and excludes detail payloads", async (t) => {
  const f = fixture(t); await f.create();
  assert.equal((await f.service.list(ws, { environment: "test", limit: 1 })).items.length, 0);
  const response = await f.service.list(ws, { environment: "live", limit: 1 });
  assert.equal(response.items.length, 1); assert.equal(response.items[0].items, undefined); assert.equal(response.items[0].addressEnc, undefined);
});
test("workspace settings cannot enable checkout or mutate settings under a stale revision", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.changeSettings(ws, { ...f.state.settings, liveCheckoutEnabled: true }), { statusCode: 400 });
  await assert.rejects(f.service.changeSettings(ws, { ...f.state.settings, revision: 0 }), { statusCode: 409 });
  const updated = await f.service.changeSettings(ws, { ...f.state.settings, deliveryEnabled: false });
  assert.equal(updated.revision, 2); assert.equal(updated.deliveryEnabled, false); assert.equal(updated.liveCheckoutEnabled, undefined);
});
