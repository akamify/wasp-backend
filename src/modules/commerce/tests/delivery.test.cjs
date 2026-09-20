require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const d = require("../delivery/domain"), v = require("../delivery/validators"), repo = require("../delivery/repository"), service = require("../delivery/service");
const orders = require("../repositories/orders.repository"), operations = require("../repositories/operations.repository");
const ws = "100000000000000000000001", id = "200000000000000000000001", riderId = "300000000000000000000001", user = "400000000000000000000001", outletId = "500000000000000000000001";
function fixture(t, status = "awaiting_rider") {
  const r = { _id: id, workspaceId: ws, orderId: id, outletId, environment: "live", status, revision: 1, preparationStatus: "ready", courierId: riderId, activeCourierId: status === "awaiting_rider" ? null : riderId, pinFailures: 0 };
  const c = { _id: riderId, workspaceId: ws, userId: user, vehicle: "motorcycle", active: true, online: true, allowedOutletIds: [outletId], revision: 1, currentDeliveryId: status === "awaiting_rider" ? null : id,
    location: { latitude: 26, longitude: 80, accuracy: 10, capturedAt: new Date(), receivedAt: new Date() } };
  const o = { _id: id, workspaceId: ws, revision: 1, status: "processing", paymentStatus: "captured", fulfillmentMethod: "delivery" };
  const notices = [], originalKey = process.env.CREDENTIALS_ENCRYPTION_KEY, originalFlag = process.env.COMMERCE_DELIVERY_ENABLED, originalManual = process.env.COMMERCE_MANUAL_DISPATCH_ENABLED;
  process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString("base64"); process.env.COMMERCE_DELIVERY_ENABLED = "true"; process.env.COMMERCE_MANUAL_DISPATCH_ENABLED = "true";
  t.after(() => { for (const [key, value] of Object.entries({ CREDENTIALS_ENCRYPTION_KEY: originalKey, COMMERCE_DELIVERY_ENABLED: originalFlag, COMMERCE_MANUAL_DISPATCH_ENABLED: originalManual })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  let queue = Promise.resolve();
  t.mock.method(repo, "transaction", (fn) => { const run = queue.then(() => fn({ testSession: true })); queue = run.catch(() => {}); return run; });
  t.mock.method(repo, "get", async (kind, scope, key) => scope === ws && ((kind === "Delivery" && String(key) === id) || (kind === "Courier" && String(key) === riderId)) ? structuredClone(kind === "Delivery" ? r : c) : null);
  t.mock.method(repo, "update", async (kind, old, patch) => { const target = kind === "Delivery" ? r : c; if (old.revision !== target.revision) return null; Object.assign(target, patch); target.revision++; return structuredClone(target); });
  t.mock.method(repo.Delivery, "exists", () => ({ session: async () => null }));
  t.mock.method(repo, "notice", async (...args) => notices.push(args));
  t.mock.method(orders, "order", async (scope) => scope === ws ? structuredClone(o) : null);
  t.mock.method(operations, "hasPaymentIssue", async () => false);
  t.mock.method(operations, "transitionOrder", async (_order, patch) => { Object.assign(o, patch); return o; });
  return { r, c, o, notices };
}
test("manual dispatch domain enforces fresh eligible riders and separate transitions", () => {
  const now = new Date(), c = { active: true, online: true, currentDeliveryId: null, allowedOutletIds: [outletId], location: { accuracy: 50, capturedAt: now, receivedAt: now } };
  assert.ok(d.eligible(c, outletId, now));
  for (const patch of [{ active: false }, { online: false }, { currentDeliveryId: id }, { allowedOutletIds: [] }, { location: { ...c.location, accuracy: 150 } }, { location: { ...c.location, capturedAt: new Date(now - 61000) } }]) assert.ok(!d.eligible({ ...c, ...patch }, outletId, now));
  assert.throws(() => d.transition("picked_up", "awaiting_rider")); assert.throws(() => d.transition("assigned", "delivered")); assert.throws(() => d.transition("delivered", "assigned"));
  assert.equal(d.distance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  assert.ok(d.distance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) > 111000);
});
test("delivery validation rejects unconfirmed coordinates, unsafe fields and malformed opening hours", () => {
  assert.throws(() => v.parse(v.location, { latitude: 91, longitude: 0, source: "gps", confirmed: true }));
  assert.throws(() => v.parse(v.location, { latitude: 0, longitude: 0, source: "gps", confirmed: false }));
  assert.throws(() => v.parse(v.offer, { revision: 1, courierId: riderId, idempotencyKey: require("crypto").randomUUID(), paymentStatus: "captured" }));
  assert.throws(() => v.parse(v.outlet, { name: "Cafe", address: "Address", latitude: 26, longitude: 80, active: true, prepMinutes: 15, radiusMetres: 1000, openingHours: [{ day: 1, open: "22:00", close: "08:00" }] }));
  assert.equal(service.isOpen({ openingHours: [{ day: 1, open: "09:00", close: "10:00" }] }, new Date("2026-09-14T04:00:00Z")), true);
  assert.equal(service.isOpen({ openingHours: [{ day: 1, open: "09:00", close: "10:00" }] }, new Date("2026-09-14T04:30:00Z")), false);
});
test("manual offers reserve one rider and retries retain the same offer", async (t) => {
  const f = fixture(t), input = { revision: 1, courierId: riderId, idempotencyKey: require("crypto").randomUUID() };
  const first = await service.offer(ws, id, input, user); assert.equal(first.status, "offer_sent"); assert.equal(f.c.currentDeliveryId, id);
  const retry = await service.offer(ws, id, input, user); assert.equal(retry.revision, first.revision); assert.equal(f.notices.length, 2);
  assert.equal(f.r.activeCourierId, riderId);
  assert.equal(f.r.autoDispatchPaused, true);
});

test("automatic offer rechecks settings, GPS, vehicle, expiry and conflicts inside the reservation transaction", async (t) => {
  const f = fixture(t), settings = require("../delivery/routingSettings");
  const config = { ...settings.defaults, ...settings.smartDefaults, revision: 2, autoDispatch: true };
  const context = { settingsRevision: 2, expiresAt: new Date(Date.now() + 15000), gpsAt: f.c.location.capturedAt, vehicle: "motorcycle" };
  const input = { revision: 1, courierId: riderId, idempotencyKey: require("crypto").randomUUID() };
  f.r.pickupEnc = service.seal(f.r, "pickupEnc", { latitude: 26, longitude: 80 });
  t.mock.method(settings, "autoEnabled", () => true); t.mock.method(settings, "routingEnabled", () => true);
  t.mock.method(settings, "get", async () => ({ ...config })); t.mock.method(orders, "workspaceActive", async () => true);
  repo.get.mock.mockImplementation(async (kind, scope, key) => scope === ws ? structuredClone(kind === "Outlet" ? { _id: outletId, workspaceId: ws, active: true, revision: 1 } : kind === "Delivery" ? f.r : f.c) : null);
  repo.update.mock.mockImplementation(async (kind, old, patch) => { if (kind === "Outlet") return old; const target = kind === "Delivery" ? f.r : f.c; if (old.revision !== target.revision) return null; Object.assign(target, patch); target.revision++; return structuredClone(target); });
  let fences = 0;
  t.mock.method(repo.RoutingSettings, "updateOne", async (filter, change, options) => {
    assert.equal(filter.workspaceId, ws); assert.equal(filter.revision, 2); assert.equal(filter.autoDispatch, true);
    assert.equal(change.$inc.dispatchFence, 1); assert.ok(options.session); fences++; return { modifiedCount: 1 };
  });
  for (const patch of [{ expiresAt: new Date(0) }, { settingsRevision: 1 }, { gpsAt: new Date(0) }, { vehicle: "car" }])
    await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", { ...context, ...patch }), /changed or expired/);
  for (const patch of [{ autoDispatch: false }, { strategy: "MANUAL" }, { revision: 3 }]) {
    const previous = { ...config }; Object.assign(config, patch);
    await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", context), /changed or expired/); Object.assign(config, previous);
  }
  assert.equal(fences, 0);
  f.r.autoDispatchPaused = true; await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", context)); f.r.autoDispatchPaused = false;
  f.r.autoOfferedCourierIds = [riderId]; await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", context)); f.r.autoOfferedCourierIds = [];
  repo.Delivery.exists.mock.mockImplementation(() => ({ session: async () => ({ _id: "another-delivery" }) }));
  await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", context), /active delivery or offer/);
  repo.Delivery.exists.mock.mockImplementation(() => ({ session: async () => null }));
  config.allowedVehicles = ["car"]; await assert.rejects(service.offer(ws, id, input, "system:auto-dispatch", context), /vehicle/); config.allowedVehicles = ["motorcycle"];
  assert.equal(f.r.status, "awaiting_rider");
  const result = await service.offer(ws, id, input, "system:auto-dispatch", context);
  assert.equal(result.status, "offer_sent"); assert.equal(f.c.currentDeliveryId, id); assert.equal(f.r.autoDispatchPaused, false);
  assert.deepEqual(f.r.autoOfferedCourierIds, [riderId]); assert.ok(f.notices.some((n) => n[1] === "auto_offer_sent"));
});

test("merchant takeover withdraws an offer, releases rider and resume resets only automatic attempts", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.autoAttempts = 5; f.r.autoOfferedCourierIds = [riderId];
  await assert.rejects(service.action(ws, id, { revision: 1, action: "pause_auto" }, user, true), /not permitted/);
  const paused = await service.action(ws, id, { revision: 1, action: "pause_auto" }, user);
  assert.equal(paused.status, "awaiting_manual_assignment"); assert.equal(paused.autoDispatchPaused, true); assert.equal(f.c.currentDeliveryId, null); assert.equal(f.r.activeCourierId, null);
  await assert.rejects(service.action(ws, id, { revision: 1, action: "resume_auto" }, user), /changed/);
  const resumed = await service.action(ws, id, { revision: f.r.revision, action: "resume_auto" }, user);
  assert.equal(resumed.autoDispatchPaused, false); assert.equal(f.r.autoAttempts, 0); assert.deepEqual(f.r.autoOfferedCourierIds, []);
});

test("manual offer revalidates configurable GPS uncertainty, freshness and pickup radius and snapshots offer lifetime", async (t) => {
  const f = fixture(t), config = require("../delivery/routingSettings");
  t.mock.method(config, "routingEnabled", () => true);
  t.mock.method(config, "get", async () => ({ pickupRadiusMetres: 1000, locationMaxAgeSeconds: 120, maxAccuracyMetres: 25, offerSeconds: 45 }));
  f.r.pickupEnc = service.seal(f.r, "pickupEnc", { latitude: 26, longitude: 80 });
  const input = { revision: 1, courierId: riderId, idempotencyKey: require("crypto").randomUUID() };
  f.c.location.accuracy = 30; await assert.rejects(service.offer(ws, id, input, user), /accurate GPS/);
  f.c.location.accuracy = 10; f.c.location.latitude = 27; await assert.rejects(service.offer(ws, id, input, user), /pickup radius/);
  f.c.location.latitude = 26; f.c.location.capturedAt = new Date(Date.now() - 90000);
  const before = Date.now(); await service.offer(ws, id, input, user);
  assert.ok(new Date(f.r.offerExpiresAt).getTime() >= before + 45000); assert.ok(new Date(f.r.offerExpiresAt).getTime() <= Date.now() + 45000);
});
test("foreign records, unpaid orders and disabled dispatch cannot offer a delivery", async (t) => {
  const f = fixture(t), input = { revision: 1, courierId: riderId, idempotencyKey: require("crypto").randomUUID() };
  await assert.rejects(service.offer(outletId, id, input, user), (e) => e.statusCode === 404);
  f.o.paymentStatus = "pending"; await assert.rejects(service.offer(ws, id, input, user));
  f.o.paymentStatus = "captured"; process.env.COMMERCE_MANUAL_DISPATCH_ENABLED = "false"; await assert.rejects(service.offer(ws, id, input, user), (e) => e.statusCode === 503);
});
test("competing acceptance is revision fenced and expired/foreign offers cannot be accepted", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.offerExpiresAt = new Date(Date.now() + 20000);
  await assert.rejects(service.action(ws, id, { revision: 1, action: "accept" }, "other", true), (e) => e.statusCode === 404);
  const results = await Promise.allSettled([service.action(ws, id, { revision: 1, action: "accept" }, user, true), service.action(ws, id, { revision: 1, action: "accept" }, user, true)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.r.status, "assigned");
  f.r.status = "offer_sent"; f.r.offerExpiresAt = new Date(Date.now() - 1); await assert.rejects(service.action(ws, id, { revision: f.r.revision, action: "accept" }, user, true));
});
test("decline releases the rider; pickup requires ready food; post-pickup reassignment is blocked", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.offerExpiresAt = new Date(Date.now() + 20000);
  await service.action(ws, id, { revision: 1, action: "decline" }, user, true); assert.equal(f.c.currentDeliveryId, null); assert.equal(f.r.status, "awaiting_manual_assignment");
  f.r.status = "arrived_at_pickup"; f.r.preparationStatus = "preparing"; await assert.rejects(service.action(ws, id, { revision: f.r.revision, action: "picked_up" }, user, true));
  f.r.status = "picked_up"; await assert.rejects(service.action(ws, id, { revision: f.r.revision, action: "reassign", reason: "Another rider" }, user));
});
test("PIN failures persist, completion invalidates secrets and releases rider", async (t) => {
  const f = fixture(t, "out_for_delivery"); f.o.status = "out_for_delivery"; f.r.pinHash = service.pinDigest(id, "123456"); f.r.pinEnc = "encrypted"; f.r.trackingHash = "secret";
  await assert.rejects(service.action(ws, id, { revision: 1, action: "delivered", pin: "000000" }, user, true), (e) => e.statusCode === 400);
  assert.equal(f.r.pinFailures, 1); assert.equal(f.r.status, "out_for_delivery");
  await service.action(ws, id, { revision: f.r.revision, action: "delivered", pin: "123456" }, user, true);
  assert.equal(f.o.status, "completed"); assert.equal(f.r.pinHash, ""); assert.equal(f.r.pinEnc, ""); assert.equal(f.r.trackingHash, ""); assert.equal(f.c.currentDeliveryId, null);
  assert.ok(!JSON.stringify(d.deliveryDto({ ...f.r, pinEnc: "private-pin", pinHash: "private-hash" })).includes("private"));
});
test("PIN lock and override permission cannot be bypassed", async (t) => {
  const f = fixture(t, "out_for_delivery"); f.o.status = "out_for_delivery"; f.r.pinHash = service.pinDigest(id, "123456"); f.r.pinFailures = 4;
  await assert.rejects(service.action(ws, id, { revision: 1, action: "delivered", pin: "000000" }, user, true));
  await assert.rejects(service.action(ws, id, { revision: f.r.revision, action: "delivered", pin: "123456" }, user, true), (e) => e.statusCode === 429);
  await assert.rejects(service.action(ws, id, { revision: f.r.revision, action: "override", reason: "Customer confirmed" }, user), (e) => e.statusCode === 403);
  await service.action(ws, id, { revision: f.r.revision, action: "override", reason: "Customer confirmed" }, user, false, true); assert.equal(f.r.status, "delivered");
});
test("delivery unique indexes enforce one order and one active courier; models disable automatic index creation", () => {
  assert.ok(repo.Delivery.schema.indexes().some(([key, options]) => key.orderId === 1 && options.unique));
  assert.ok(repo.Delivery.schema.indexes().some(([key, options]) => key.activeCourierId === 1 && options.unique && options.partialFilterExpression));
  for (const Model of [repo.Outlet, repo.Courier, repo.Delivery, repo.Stock, repo.Notice]) assert.equal(Model.schema.options.autoIndex, false);
});

test("rider fulfillment uses the original merchant authorization for native status notifications", async (t) => {
  const f = fixture(t, "arrived_at_pickup"); f.o.paidAttemptId = "attempt";
  t.mock.method(operations, "attempt", async () => ({ mode: "whatsapp_native", requestedBy: "merchant-owner" }));
  const messages = []; t.mock.method(operations, "outbox", async (record) => messages.push(record));
  await service.action(ws, id, { revision: 1, action: "picked_up" }, user, true);
  assert.equal(f.r.status, "picked_up"); assert.ok(f.r.pickedUpAt);
  assert.equal(messages.length, 1); assert.equal(messages[0].requestedBy, "merchant-owner");
  assert.ok(f.notices.some((n) => n[2] === user));
});

test("rejecting an unpaid accepted order closes its sidecar and invalidates customer secrets", async (t) => {
  const f = fixture(t, "pending_dispatch"); f.o.manualDeliveryId = id;
  await service.rejectPending(f.o, {});
  assert.equal(f.r.status, "cancelled"); assert.equal(f.r.preparationStatus, "rejected"); assert.equal(f.r.trackingHash, "");
  assert.equal(f.notices.length, 1); await service.rejectPending(f.o, {}); assert.equal(f.notices.length, 1);
  f.r.status = "assigned"; await assert.rejects(service.rejectPending(f.o, {}));
});

test("checkout checks only the accepted branch in one stock query and rejects an altered quote", async (t) => {
  const f = fixture(t, "pending_dispatch"); f.o.items = [{ productId: id, quantity: 2, unitPricePaise: 100 }];
  f.r.preparationStatus = "accepted"; f.r.acceptedHash = service.signature(f.o);
  t.mock.method(repo, "byOrder", async () => structuredClone(f.r));
  const outlet = { _id: outletId, workspaceId: ws, revision: 1, active: true, openingHours: Array.from({ length: 7 }, (_, day) => ({ day, open: "00:00", close: "23:59" })) };
  t.mock.method(repo, "get", async () => outlet); const writes = [];
  t.mock.method(repo, "update", async (kind, old, patch) => { writes.push(kind); return { ...old, ...patch }; });
  let enough = true, reads = 0;
  t.mock.method(repo.Stock, "find", (filter) => { reads++; assert.equal(filter.workspaceId, ws); assert.equal(filter.outletId, outletId); assert.deepEqual(filter.productId.$in, [id]);
    return { session: () => ({ lean: async () => [{ productId: id, available: enough, stockOnHand: 3, stockReserved: 1 }] }) }; });
  // Freeze only this check's opening-hour input away from its closing boundary.
  t.mock.method(Intl, "DateTimeFormat", function () { return { formatToParts: () => [{ type: "weekday", value: "Mon" }, { type: "hour", value: "12" }, { type: "minute", value: "00" }] }; });
  assert.equal((await service.checkoutGuard(f.o, {})).outletId, outletId); assert.equal(reads, 1); assert.deepEqual(writes, ["Outlet", "Delivery"]);
  enough = false; await assert.rejects(service.checkoutGuard(f.o, {}), /branch inventory/);
  f.o.items[0].quantity = 3; await assert.rejects(service.checkoutGuard(f.o, {}), /Accept this delivery order/);
});

test("expiring an offer releases its courier and persists notifications once", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.offerExpiresAt = new Date(Date.now() - 1000); f.r.activeCourierId = riderId;
  t.mock.method(repo.Delivery, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => [structuredClone(f.r)] }) }) }));
  await service.expireOffers(); assert.equal(f.r.status, "awaiting_manual_assignment"); assert.equal(f.c.currentDeliveryId, null); assert.equal(f.r.activeCourierId, null); assert.equal(f.notices.length, 3);
  await service.expireOffers(); assert.equal(f.notices.length, 3);
});

test("customer tracking uses random rotating bearer secrets and never returns the PIN to the merchant", async (t) => {
  const f = fixture(t, "assigned");
  const first = await service.trackingLink(ws, id, 1), hash = f.r.trackingHash;
  assert.match(first.token, /^[a-f0-9]{64}$/); assert.deepEqual(Object.keys(first), ["token"]);
  const pin = service.open(f.r, "pinEnc"); assert.match(pin, /^\d{6}$/); assert.notEqual(f.r.pinEnc, pin); assert.equal(f.r.pinHash, service.pinDigest(id, pin));
  const next = await service.trackingLink(ws, id, f.r.revision); assert.notEqual(next.token, first.token); assert.notEqual(f.r.trackingHash, hash);
  f.r.status = "delivered"; await assert.rejects(service.trackingLink(ws, id, f.r.revision));
});

test("automatic failure commits manual assignment and its alert once without cancelling or changing payment", async (t) => {
  const f = fixture(t), before = structuredClone(f.o), record = structuredClone(f.r);
  const outcomes = await Promise.all([service.dispatchFailure(record, "No eligible rider"), service.dispatchFailure(record, "No eligible rider")]);
  assert.equal(outcomes.filter(Boolean).length, 1); assert.equal(f.r.status, "awaiting_manual_assignment");
  assert.equal(f.r.autoDispatchPaused, true); assert.deepEqual(f.o, before);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0][1], "awaiting_manual_assignment");
  // Manual dispatch remains actionable after failure.
  await service.offer(ws, id, { revision: f.r.revision, courierId: riderId, idempotencyKey: require("crypto").randomUUID() }, user);
  assert.equal(f.r.status, "offer_sent");
});

test("stale workers cannot downgrade a newer lease, accepted delivery or manual takeover", async (t) => {
  const f = fixture(t); f.r.autoAttempts = 2;
  assert.equal(await service.dispatchFailure({ ...f.r, autoAttempts: 1 }, "Old attempt"), false);
  const old = structuredClone(f.r); f.r.status = "assigned";
  assert.equal(await service.dispatchFailure(old, "Old attempt"), false); assert.equal(f.notices.length, 0);
  f.r.status = "awaiting_rider"; f.r.autoDispatchPaused = true;
  assert.equal(await service.dispatchFailure(old, "Old attempt"), false);
});

test("a failed durable notification rolls back fallback and a later recovery can retry", async (t) => {
  const f = fixture(t), record = structuredClone(f.r); let unavailable = true;
  repo.transaction.mock.mockImplementation(async (fn) => {
    const snapshot = structuredClone(f.r);
    try { return await fn({ testSession: true }); } catch (e) { for (const key of Object.keys(f.r)) delete f.r[key]; Object.assign(f.r, snapshot); throw e; }
  });
  repo.notice.mock.mockImplementation(async (...args) => { if (unavailable) throw new Error("Storage temporarily unavailable"); f.notices.push(args); });
  await assert.rejects(service.dispatchFailure(record, "Routing unavailable"), /Storage/);
  assert.equal(f.r.status, "awaiting_rider"); assert.equal(f.r.revision, record.revision); assert.equal(f.notices.length, 0);
  unavailable = false;
  assert.equal(await service.dispatchFailure(record, "Routing unavailable"), true);
  assert.equal(f.notices.length, 1); assert.equal(f.o.paymentStatus, "captured");
});

test("acceptance rejects stale GPS, broken reservations and two distinct riders competing", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.offerExpiresAt = new Date(Date.now() + 20000);
  const gps = f.c.location.capturedAt; f.c.location.capturedAt = new Date(Date.now() - 61000);
  await assert.rejects(service.action(ws, id, { revision: 1, action: "accept" }, user, true), /GPS/);
  f.c.location.capturedAt = gps; f.c.currentDeliveryId = "another-delivery";
  await assert.rejects(service.action(ws, id, { revision: 1, action: "accept" }, user, true), /reservation changed/);
  f.c.currentDeliveryId = id;
  const results = await Promise.allSettled([service.action(ws, id, { revision: 1, action: "accept" }, user, true), service.action(ws, id, { revision: 1, action: "accept" }, "another-rider-user", true)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.r.status, "assigned"); assert.equal(f.r.activeCourierId, riderId);
});

test("automatic offer expiry schedules the next rider immediately and preserves exclusion history", async (t) => {
  const f = fixture(t, "offer_sent"), settings = require("../delivery/routingSettings");
  f.r.offerExpiresAt = new Date(Date.now() - 1); f.r.autoNextAttemptAt = new Date(Date.now() + 60000); f.r.autoOfferedCourierIds = [riderId];
  t.mock.method(settings, "autoEnabled", () => true); t.mock.method(settings, "get", async () => ({ autoDispatch: true, strategy: "SMART" }));
  t.mock.method(repo.Delivery, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => [structuredClone(f.r)] }) }) }));
  assert.deepEqual(await service.expireOffers(), { expired: 1, failed: 0 });
  assert.equal(f.r.status, "awaiting_rider"); assert.equal(f.r.autoNextAttemptAt, null); assert.deepEqual(f.r.autoOfferedCourierIds, [riderId]); assert.equal(f.c.currentDeliveryId, null);
});

test("expiry recovery processes other records after a failed transaction and missing riders require manual assignment", async (t) => {
  const f = fixture(t, "offer_sent"); f.r.offerExpiresAt = new Date(Date.now() - 1);
  t.mock.method(repo.Delivery, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => [{ ...f.r, _id: "missing" }, structuredClone(f.r)] }) }) }));
  repo.get.mock.mockImplementation(async (kind, scope, key) => kind === "Delivery" && key === id && scope === ws ? structuredClone(f.r) : null);
  const result = await service.expireOffers(); assert.deepEqual(result, { expired: 1, failed: 1 }); assert.equal(f.r.status, "awaiting_manual_assignment");
  assert.ok(f.notices.some((n) => n[1] === "awaiting_manual_assignment")); assert.equal(f.o.status, "processing");
});
