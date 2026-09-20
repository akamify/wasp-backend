require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const batch = require("../delivery/batching"), repo = require("../delivery/repository"), service = require("../delivery/service"), settings = require("../delivery/routingSettings");
const orders = require("../repositories/orders.repository"), operations = require("../repositories/operations.repository"), google = require("../delivery/googleRoutes");
const ws = "100000000000000000000001", outletId = "200000000000000000000001", courierId = "300000000000000000000001", zoneId = "400000000000000000000001", tripId = "500000000000000000000001";
function fixture(t, count = 2) {
  for (const key of ["COMMERCE_DELIVERY_ENABLED", "COMMERCE_MANUAL_DISPATCH_ENABLED", "COMMERCE_ROUTING_ENABLED", "COMMERCE_BATCHING_ENABLED"]) { const old = process.env[key]; process.env[key] = "true"; t.after(() => old === undefined ? delete process.env[key] : process.env[key] = old); }
  const now = new Date(), zone = { _id: zoneId, workspaceId: ws, outletId, revision: 1, latitude: 26, longitude: 80, radiusMetres: 4000, active: true, autoAssign: true, prepToleranceSeconds: 300, maxWaitSeconds: 300, maxTripSeconds: 3600, maxDetourSeconds: 600, stopSeconds: 120 };
  const courier = { _id: courierId, workspaceId: ws, userId: courierId, revision: 1, active: true, online: true, vehicle: "car", allowedOutletIds: [outletId], allowedZoneIds: [zoneId], batchCapacity: 10, batchLoad: 0, batchAutoAssign: true, currentTripId: null, currentDeliveryId: null,
    location: { latitude: 26, longitude: 80, capturedAt: now, receivedAt: now, accuracy: 10 } };
  const rows = Array.from({ length: count }, (_, i) => ({ _id: (BigInt("0x600000000000000000000000") + BigInt(i)).toString(16), workspaceId: ws, orderId: (BigInt("0x600000000000000000000000") + BigInt(i)).toString(16), revision: 1, outletId, environment: "test", status: "awaiting_rider", preparationStatus: "preparing", readyAt: now, location: { latitude: 26.001 + i * 0.001, longitude: 80 } }));
  const f = { data: { Zone: [zone], Courier: [courier], Delivery: rows, Trip: [], Outlet: [{ _id: outletId, workspaceId: ws, active: true, revision: 1 }] }, notices: [], paid: true, routes: 0, conflict: false,
    config: { ...settings.defaults, ...settings.smartDefaults, revision: 1, autoDispatch: true }, matrixError: false };
  t.mock.method(require("../delivery/readiness"), "routingReady", async () => {});
  t.mock.method(require("../models/indexPlan"), "checkIndexes", async () => []);
  t.mock.method(settings, "get", async () => f.config); t.mock.method(settings, "autoEnabled", () => true);
  t.mock.method(repo, "get", async (kind, scope, id) => structuredClone(f.data[kind].find((r) => r.workspaceId === scope && String(r._id) === String(id)) || null));
  t.mock.method(repo, "update", async (kind, record, patch) => { const row = f.data[kind].find((r) => r._id === record._id && r.workspaceId === record.workspaceId && r.revision === record.revision); if (!row) return null; Object.assign(row, structuredClone(patch)); row.revision++; return structuredClone(row); });
  t.mock.method(repo, "create", async (kind, fields) => { const row = { ...structuredClone(fields), _id: tripId, revision: 1, status: "loading" }; f.data[kind].push(row); return structuredClone(row); });
  let queue = Promise.resolve();
  t.mock.method(repo, "transaction", (fn) => { const run = queue.then(async () => { const snapshot = structuredClone(f.data), notices = f.notices.length; try { return await fn({ test: true }); } catch (e) { f.data = snapshot; f.notices.length = notices; throw e; } }); queue = run.catch(() => {}); return run; });
  t.mock.method(repo, "notice", async (...args) => f.notices.push(args));
  t.mock.method(repo.Zone, "updateOne", async (query) => ({ modifiedCount: f.data.Zone[0].revision === query.revision ? 1 : 0 }));
  t.mock.method(repo.RoutingSettings, "updateOne", async () => ({ modifiedCount: 1 }));
  t.mock.method(repo.Delivery, "exists", () => ({ session: async () => f.conflict ? {} : null }));
  t.mock.method(repo.Delivery, "find", (query) => ({ session: () => ({ lean: async () => f.data.Delivery.filter((r) => query._id.$in.includes(r._id)) }) }));
  t.mock.method(orders, "workspaceActive", async () => true);
  t.mock.method(orders, "order", async () => ({ status: "processing", paymentStatus: f.paid ? "captured" : "unpaid", fulfillmentMethod: "delivery" }));
  t.mock.method(operations, "hasPaymentIssue", async () => false); t.mock.method(operations, "transitionOrder", async () => true);
  t.mock.method(service, "open", (r, key) => key === "pickupEnc" ? { latitude: 26, longitude: 80 } : { location: r.location });
  t.mock.method(google, "matrix", async (origins, destinations) => { f.routes++; if (f.matrixError) throw new Error("Unavailable"); const result = new Map(); origins.forEach((_o, i) => destinations.forEach((_d, j) => result.set(`${i}:${j}`, { seconds: 60, metres: 100 }))); return result; });
  f.input = () => ({ zoneId, courierId, idempotencyKey: randomUUID(), deliveries: f.data.Delivery.filter((r) => r.status === "awaiting_rider").map((r) => ({ id: r._id, revision: r.revision })) });
  return f;
}
test("batch validation rejects duplicate selections, cross-tenant fields and invalid radius/limits", () => {
  const v = require("../delivery/validators");
  assert.throws(() => v.parse(batch.assignSchema, { courierId, zoneId, idempotencyKey: randomUUID(), deliveries: [{ id: tripId, revision: 1 }, { id: tripId, revision: 1 }] }));
  assert.throws(() => v.parse(batch.assignSchema, { courierId, zoneId, workspaceId: ws, idempotencyKey: randomUUID(), deliveries: [{ id: tripId, revision: 1 }] }));
  assert.throws(() => v.parse(batch.zoneSchema, { name: "Zone", radiusMetres: 0 }));
  assert.ok(repo.Trip.schema.indexes().some(([key, options]) => key.activeCourierId === 1 && options.unique));
});
test("compatibility enforces merchant, outlet, environment, radius, preparation, capacity and departure", (t) => {
  const f = fixture(t), rows = f.data.Delivery, zone = f.data.Zone[0], c = f.data.Courier[0];
  assert.ok(batch.compatible(rows, zone, c, null));
  for (const patch of [{ workspaceId: courierId }, { outletId: courierId }, { environment: "live" }, { location: { latitude: 27, longitude: 80 } }, { readyAt: new Date(Date.now() + 900000) }, { status: "exception" }]) assert.throws(() => batch.compatible([rows[0], { ...rows[1], ...patch }], zone, c, null));
  assert.throws(() => batch.compatible(rows, zone, { ...c, batchCapacity: 1 }, null));
  assert.throws(() => batch.compatible(rows, zone, c, { status: "departed", zoneId }));
  assert.throws(() => batch.compatible(rows, zone, c, { status: "loading", zoneId, latestDepartureAt: new Date(0) }));
});
test("manual preview has no mutations; assignment reserves capacity atomically and retry is idempotent", async (t) => {
  const f = fixture(t), input = f.input();
  const preview = await batch.assign(ws, input, "manager", false, true); assert.equal(preview.totalOrders, 2); assert.equal(f.data.Trip.length, 0); assert.equal(f.notices.length, 0);
  const trip = await batch.assign(ws, input, "manager"); assert.equal(trip.deliveryIds.length, 2); assert.equal(f.data.Courier[0].batchLoad, 2);
  assert.ok(f.data.Delivery.every((r) => r.status === "offer_sent" && r.tripId === tripId && r.activeCourierId === null));
  await batch.assign(ws, input, "manager"); assert.equal(f.data.Trip.length, 1); assert.equal(f.notices.length, 4);
});
test("concurrent bulk requests cannot consume the same courier slots twice", async (t) => {
  const f = fixture(t); f.data.Courier[0].batchCapacity = 2;
  const result = await Promise.allSettled([batch.assign(ws, f.input(), "manager"), batch.assign(ws, f.input(), "manager")]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1); assert.equal(f.data.Trip.length, 1); assert.equal(f.data.Courier[0].batchLoad, 2);
});
test("unpaid, foreign, stale GPS and legacy reservations cannot enter trips", async (t) => {
  const f = fixture(t); f.paid = false; await assert.rejects(batch.assign(ws, f.input(), "manager")); assert.equal(f.routes, 0);
  f.paid = true; await assert.rejects(batch.assign(courierId, f.input(), "manager"));
  const now = f.data.Courier[0].location.capturedAt; f.data.Courier[0].location.capturedAt = new Date(0); await assert.rejects(batch.assign(ws, f.input(), "manager"));
  f.data.Courier[0].location.capturedAt = now; f.conflict = true; await assert.rejects(batch.assign(ws, f.input(), "manager"), /single-order/); assert.equal(f.data.Trip.length, 0);
});
test("road outage and excessive detour fail closed without reserving orders", async (t) => {
  const f = fixture(t); f.matrixError = true; await assert.rejects(batch.assign(ws, f.input(), "manager")); assert.equal(f.data.Trip.length, 0);
  f.matrixError = false; f.data.Zone[0].maxDetourSeconds = 0; await assert.rejects(batch.assign(ws, f.input(), "manager"), /detour/); assert.equal(f.data.Courier[0].batchLoad, 0);
});
test("removing an order frees exactly one slot and closes only an empty trip", async (t) => {
  const f = fixture(t); await batch.assign(ws, f.input(), "manager");
  await batch.release(structuredClone(f.data.Delivery[0]), structuredClone(f.data.Courier[0]), {}); assert.equal(f.data.Courier[0].batchLoad, 1); assert.equal(f.data.Trip[0].status, "loading");
  await batch.release(structuredClone(f.data.Delivery[1]), structuredClone(f.data.Courier[0]), {}); assert.equal(f.data.Courier[0].batchLoad, 0); assert.equal(f.data.Courier[0].currentTripId, null); assert.equal(f.data.Trip[0].activeCourierId, null);
});
test("pickup waits for all acknowledgements/readiness and delivery follows stop order", async (t) => {
  const f = fixture(t); await batch.assign(ws, f.input(), "manager");
  await assert.rejects(batch.pickup(f.data.Delivery[0], f.data.Courier[0], {}), /Accept every/);
  f.data.Delivery.forEach((r) => { r.status = "arrived_at_pickup"; r.preparationStatus = "ready"; });
  await batch.pickup(f.data.Delivery[0], f.data.Courier[0], {}); assert.equal(f.data.Trip[0].status, "departed");
  await assert.rejects(batch.startDelivery(f.data.Delivery[1], f.data.Courier[0], {}), /sequence/);
  await assert.rejects(batch.startDelivery(f.data.Delivery[0], f.data.Courier[0], {}), /Collect all/);
  f.data.Delivery.forEach((r) => r.status = "picked_up"); await batch.startDelivery(f.data.Delivery[0], f.data.Courier[0], {});
});

test("trip acceptance is atomic, authenticated and cannot accept expired offers or a changed trip", async (t) => {
  const f = fixture(t); await batch.assign(ws, f.input(), "manager");
  await assert.rejects(batch.acceptTrip(ws, tripId, 1, "foreign-user"));
  f.data.Delivery[1].offerExpiresAt = new Date(0);
  await assert.rejects(batch.acceptTrip(ws, tripId, 1, courierId), /expired/);
  assert.ok(f.data.Delivery.every((r) => r.status === "offer_sent"));
  f.data.Delivery[1].offerExpiresAt = new Date(Date.now() + 20000);
  const outcomes = await Promise.allSettled([batch.acceptTrip(ws, tripId, 1, courierId), batch.acceptTrip(ws, tripId, 1, courierId)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1); assert.ok(f.data.Delivery.every((r) => r.status === "assigned"));
});

test("new orders join a loading trip only until capacity and zone controls permit", async (t) => {
  const f = fixture(t, 3); f.data.Courier[0].batchCapacity = 2;
  const input = f.input(); input.deliveries = input.deliveries.slice(0, 1);
  await batch.assign(ws, input, "manager");
  const second = { ...f.input(), deliveries: [{ id: f.data.Delivery[1]._id, revision: 1 }] };
  f.data.Zone[0].autoAssign = false; await assert.rejects(batch.assign(ws, second, "system", true), /paused/);
  f.data.Zone[0].autoAssign = true; await batch.assign(ws, second, "system", true);
  assert.equal(f.data.Trip.length, 1); assert.equal(f.data.Courier[0].batchLoad, 2);
  await assert.rejects(batch.assign(ws, f.input(), "system", true), /capacity/); assert.equal(f.data.Courier[0].batchLoad, 2);
});

test("individual decline and merchant reassignment release only their own trip slots", async (t) => {
  const f = fixture(t); await batch.assign(ws, f.input(), "manager");
  await service.action(ws, f.data.Delivery[0]._id, { revision: 2, action: "decline" }, courierId, true);
  assert.equal(f.data.Courier[0].batchLoad, 1); assert.equal(f.data.Delivery[0].tripId, null);
  assert.equal(f.data.Delivery[1].status, "offer_sent");
  await service.action(ws, f.data.Delivery[1]._id, { revision: 2, action: "reassign", reason: "Rider unavailable" }, "manager");
  assert.equal(f.data.Courier[0].batchLoad, 0); assert.equal(f.data.Trip[0].status, "completed");
  assert.ok(f.data.Delivery.every((r) => r.status === "awaiting_manual_assignment"));
});

test("expiry recovery releases expired trip offers and safely repeats after restart", async (t) => {
  const f = fixture(t); await batch.assign(ws, f.input(), "manager");
  f.data.Delivery[0].offerExpiresAt = new Date(0);
  t.mock.method(repo.Delivery, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => structuredClone(f.data.Delivery.filter((r) => r.status === "offer_sent" && new Date(r.offerExpiresAt) <= new Date())) }) }) }));
  assert.deepEqual(await service.expireOffers(), { expired: 1, failed: 0 });
  assert.equal(f.data.Courier[0].batchLoad, 1); assert.equal(f.data.Delivery[1].status, "offer_sent");
  assert.deepEqual(await service.expireOffers(), { expired: 0, failed: 0 });
  assert.equal(f.data.Courier[0].batchLoad, 1);
});

test("automatic dispatch shortlists before routing and appends to the same loading trip", async (t) => {
  const f = fixture(t); const first = f.input(); first.deliveries = first.deliveries.slice(0, 1);
  await batch.assign(ws, first, "manager");
  t.mock.method(repo.Zone, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => f.data.Zone }) }) }));
  let pipeline;
  t.mock.method(repo.Courier, "aggregate", (stages) => { pipeline = stages; return { option: async () => structuredClone(f.data.Courier) }; });
  assert.equal(await batch.automatic(structuredClone(f.data.Delivery[1])), "offered");
  assert.equal(pipeline.at(-1).$limit, f.config.routeShortlist);
  assert.ok(pipeline[0].$geoNear.query.$expr); assert.ok(pipeline[2].$match);
  assert.equal(f.data.Trip.length, 1); assert.equal(f.data.Courier[0].batchLoad, 2);
});

test("disabled matching zone falls back to manual without routing or cancelling the order", async (t) => {
  const f = fixture(t); f.data.Zone[0].autoAssign = false;
  t.mock.method(repo.Courier, "aggregate", () => ({ option: async () => [] }));
  t.mock.method(repo.Zone, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => f.data.Zone }) }) }));
  assert.equal(await batch.automatic(structuredClone(f.data.Delivery[0])), "awaiting_manual_assignment");
  assert.equal(f.routes, 0); assert.equal(f.data.Delivery[0].status, "awaiting_manual_assignment");
  assert.equal(f.data.Trip.length, 0);
});

test("dynamic batch anchors to the first customer and does not move after removal", async (t) => {
  const f = fixture(t, 3), c = f.data.Courier[0]; c.batchMode = "first_customer"; c.batchRadiusMetres = 4000; c.batchCapacity = 20;
  const input = f.input(); delete input.zoneId; input.deliveries = input.deliveries.slice(0, 2);
  await batch.assign(ws, input, "manager");
  const centre = structuredClone(f.data.Trip[0].batchCentre);
  assert.equal(centre.latitude, f.data.Delivery[0].location.latitude); assert.equal(f.data.Trip[0].zoneId, null);
  await service.action(ws, f.data.Delivery[0]._id, { revision: 2, action: "decline" }, courierId, true);
  const next = { ...f.input(), deliveries: [{ id: f.data.Delivery[2]._id, revision: 1 }] }; delete next.zoneId;
  await batch.assign(ws, next, "manager"); assert.deepEqual(f.data.Trip[0].batchCentre, centre);
  assert.equal(f.data.Courier[0].batchLoad, 2);
  const zone = batch.dynamicZone(f.data.Courier[0], f.data.Delivery[2], f.data.Trip[0]);
  assert.throws(() => batch.compatible([{ ...f.data.Delivery[2], location: { latitude: 26.2, longitude: 80 } }], zone, f.data.Courier[0], f.data.Trip[0]), /outside/);
});

test("thirty-order validation and sparse road checks preserve exact predecessor legs", async (t) => {
  const f = fixture(t, 30); f.data.Courier[0].batchCapacity = 30;
  const v = require("../delivery/validators"); assert.equal(v.parse(batch.assignSchema, f.input()).deliveries.length, 30);
  assert.throws(() => v.parse(v.courier, { email: "r@example.com", name: "R", phone: "919999999999", vehicle: "car", active: true, allowedOutletIds: [outletId], batchCapacity: 31 }));
  let elements = 0;
  google.matrix.mock.restore();
  t.mock.method(google, "matrix", async (origins, destinations) => {
    elements += origins.length * destinations.length;
    const m = new Map(); origins.forEach((o, i) => destinations.forEach((p, j) => m.set(`${i}:${j}`, { seconds: Math.round(Math.abs(p.latitude - o.latitude) * 100000), metres: 100 })));
    return m;
  });
  const rows = f.data.Delivery, route = await batch.routeCheck(rows, { latitude: 26, longitude: 80 }, "car", { maxTripSeconds: 7200, maxDetourSeconds: 0, stopSeconds: 0 });
  assert.equal(route.routeSeconds, 3000); assert.ok(elements <= 90);
});

test("dynamic automatic dispatch works without a fixed zone and obeys per-rider pickup radius", async (t) => {
  const f = fixture(t, 1); f.data.Courier[0].batchMode = "first_customer";
  t.mock.method(repo.Zone, "find", () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }));
  t.mock.method(repo.Courier, "aggregate", () => ({ option: async () => structuredClone(f.data.Courier) }));
  assert.equal(await batch.automatic(structuredClone(f.data.Delivery[0])), "offered");
  assert.equal(f.data.Trip[0].zoneId, null);
  assert.equal(batch.pickupLimit({ pickupRadiusMetres: 1000 }, f.config), 1000);
  assert.equal(batch.pickupLimit({ pickupRadiusMetres: 50000 }, f.config), f.config.pickupRadiusMetres);
});
