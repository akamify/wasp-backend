require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const routing = require("../delivery/routing"), settings = require("../delivery/routingSettings"), google = require("../delivery/googleRoutes");
const repo = require("../delivery/repository"), service = require("../delivery/service"), readiness = require("../delivery/readiness");
const orders = require("../repositories/orders.repository"), operations = require("../repositories/operations.repository");
const ws = "100000000000000000000001", id = "200000000000000000000001", outlet = "300000000000000000000001", rider = "400000000000000000000001";
const pickup = { latitude: 26, longitude: 80 }, customer = { latitude: 26.01, longitude: 80.02 };
function env(t, name, value) { const old = process.env[name]; process.env[name] = value; t.after(() => old === undefined ? delete process.env[name] : process.env[name] = old); }
test("geo shortlist pins merchant/outlet and eligibility before its bounded limit; customer mode retains pickup radius", () => {
  const now = new Date(), p = routing.pipeline(ws, { outletId: outlet }, pickup, customer, settings.defaults, "nearest_pickup", now);
  assert.deepEqual(p[0].$geoNear.near.coordinates, [80, 26]); assert.equal(p[0].$geoNear.maxDistance, 8000); assert.equal(p[0].$geoNear.key, "geoPoint");
  const q = p[0].$geoNear.query; assert.equal(String(q.workspaceId), ws); assert.equal(String(q.allowedOutletIds), outlet); assert.equal(q.currentDeliveryId, null);
  assert.equal(q.active, true); assert.equal(q.online, true); assert.equal(q["location.accuracy"].$lte, 100); assert.equal(q["location.capturedAt"].$gte.getTime(), now.getTime() - 60000);
  assert.deepEqual(p[3], { $limit: 5 });
  const nearCustomer = routing.pipeline(ws, { outletId: outlet }, pickup, customer, { ...settings.defaults, routeShortlist: 2 }, "nearest_customer", now);
  assert.deepEqual(nearCustomer[0].$geoNear.near.coordinates, [80.02, 26.01]); assert.ok(nearCustomer[0].$geoNear.query.geoPoint.$geoWithin); assert.deepEqual(nearCustomer[3], { $limit: 2 });
  assert.ok(repo.Courier.schema.indexes().some(([key]) => key.workspaceId === 1 && key.geoPoint === "2dsphere"));
});
test("dispatch settings enforce bounded integers and preserve Phase 1 defaults with routing off", async (t) => {
  const { parse } = require("../delivery/validators");
  assert.deepEqual(settings.defaults, { pickupRadiusMetres: 8000, locationMaxAgeSeconds: 60, maxAccuracyMetres: 100, routeShortlist: 5, offerSeconds: 20 });
  for (const patch of [{ routeShortlist: 0 }, { routeShortlist: 21 }, { offerSeconds: 9 }, { maxAccuracyMetres: -1 }, { locationMaxAgeSeconds: 301 }, { pickupRadiusMetres: 50001 }, { routeShortlist: 2.5 }, { workspaceId: ws }])
    assert.throws(() => parse(settings.schema, { ...settings.defaults, revision: 0, ...patch }));
  env(t, "COMMERCE_ROUTING_ENABLED", "false"); assert.equal((await settings.get(ws)).offerSeconds, 20); await assert.rejects(settings.save(ws, {}));
});
test("Google matrix uses bounded coordinates, server header key, vehicle modes, field masks and deadlines", async () => {
  const calls = [], matrix = google.createGoogleRoutes({ key: () => "server-secret", request: async (c) => { calls.push(c); return { data: [{ originIndex: 0, destinationIndex: 0, condition: "ROUTE_EXISTS", status: {}, duration: "10.2s", distanceMeters: 99 }] }; } });
  assert.equal((await matrix([pickup], [customer], "motorcycle")).get("0:0").seconds, 11);
  await matrix([pickup], [customer], "bicycle");
  assert.equal(calls[0].data.travelMode, "TWO_WHEELER"); assert.equal(calls[0].data.routingPreference, "TRAFFIC_AWARE"); assert.equal(calls[1].data.routingPreference, undefined);
  assert.equal(calls[0].headers["X-Goog-Api-Key"], "server-secret"); assert.match(calls[0].headers["X-Goog-FieldMask"], /status/);
  assert.equal(calls[0].url, "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"); assert.equal(calls[0].maxRedirects, 0); assert.equal(calls[0].timeout, 8000);
  await assert.rejects(matrix(Array(22).fill(pickup), [customer], "car")); await assert.rejects(matrix([{ latitude: 91, longitude: 80 }], [customer], "car")); assert.equal(calls.length, 2);
  const broken = google.createGoogleRoutes({ key: () => "key", request: async () => { throw new Error("secret upstream details"); } });
  await assert.rejects(broken([pickup], [customer], "car"), (e) => e.statusCode === 503 && !e.message.includes("secret"));
});
test("matrix decoding handles out-of-order, missing and failed elements without inventing ETA", () => {
  const ok = { condition: "ROUTE_EXISTS", status: {}, duration: "20s", distanceMeters: 100 };
  const decoded = google.decode([{ ...ok, originIndex: 1 }, { ...ok, duration: "garbage" }, { originIndex: 1, destinationIndex: 1, condition: "ROUTE_NOT_FOUND" }], 2, 2);
  assert.equal(decoded.get("1:0").seconds, 20); assert.equal(decoded.get("0:0"), null); assert.equal(decoded.get("1:1"), null); assert.equal(decoded.get("0:1"), undefined);
  assert.throws(() => google.decode([ok, ok], 2, 2)); assert.throws(() => google.decode([{ ...ok, originIndex: 3 }], 2, 2));
});
test("ranking separates direct customer proximity from pickup and prep-aware suggested delivery", () => {
  const now = new Date(), c = (key) => ({ _id: key, name: key, vehicle: "car", location: { ...pickup, capturedAt: now, accuracy: 10 } });
  const matrix = new Map([["0:0", { seconds: 20, metres: 100 }], ["1:0", { seconds: 40, metres: 200 }], ["0:1", { seconds: 200, metres: 900 }], ["1:1", { seconds: 30, metres: 100 }], ["2:1", { seconds: 300, metres: 1000 }]]);
  const args = [{ car: [c("a"), c("b")] }, { car: matrix }, pickup, customer];
  assert.equal(routing.rank(...args, "nearest_pickup", null, now)[0].courierId, "a");
  assert.equal(routing.rank(...args, "nearest_customer", null, now)[0].courierId, "b");
  const suggested = routing.rank(...args, "suggested", new Date(now.getTime() + 120000), now);
  assert.equal(suggested[0].deliveryEtaSeconds, 540); assert.equal(suggested[1].deliveryEtaSeconds, 540);
  matrix.delete("2:1"); assert.equal(routing.rank(...args, "suggested", null, now).length, 0);
});
function fixture(t) {
  env(t, "COMMERCE_GOOGLE_ROUTES_API_KEY", "test-key");
  const now = new Date(), r = { _id: id, workspaceId: ws, orderId: id, outletId: outlet, revision: 4, status: "awaiting_rider", readyAt: now };
  const c = { _id: rider, name: "Test rider", vehicle: "car", active: true, online: true, currentDeliveryId: null, allowedOutletIds: [outlet], location: { ...pickup, accuracy: 10, capturedAt: now, receivedAt: now } };
  const f = { r, c, calls: 0, claim: true, paid: true, shortlist: [c] };
  t.mock.method(readiness, "routingReady", async () => {});
  t.mock.method(service, "required", async (_kind, scope) => { if (scope !== ws) require("../delivery/domain").fail("Not found", 404); return { ...r }; });
  t.mock.method(service, "open", (_r, key) => key === "pickupEnc" ? pickup : { location: customer });
  t.mock.method(settings, "get", async () => ({ ...settings.defaults }));
  t.mock.method(orders, "order", async () => ({ paymentStatus: f.paid ? "captured" : "pending", fulfillmentMethod: "delivery", status: "processing" }));
  t.mock.method(operations, "hasPaymentIssue", async () => false);
  t.mock.method(repo.Delivery, "updateOne", async () => ({ modifiedCount: f.claim ? 1 : 0 }));
  t.mock.method(repo.Courier, "aggregate", () => ({ option: async () => structuredClone(f.shortlist) }));
  t.mock.method(repo.Delivery, "find", () => ({ select: () => ({ lean: async () => f.conflicts || [] }) }));
  t.mock.method(repo.Courier, "find", () => ({ lean: async () => [c] }));
  t.mock.method(google, "matrix", async (origins) => { f.calls++; assert.ok(origins.length <= settings.defaults.routeShortlist + 1); return new Map([["0:0", { seconds: 20, metres: 100 }], ["0:1", { seconds: 40, metres: 200 }], ["1:1", { seconds: 60, metres: 300 }]]); });
  return f;
}
test("recommendations use only a bounded shortlist, require paid ownership and never create an offer", async (t) => {
  const f = fixture(t); t.mock.method(service, "offer", async () => assert.fail("Must not assign or offer"));
  const response = await routing.recommend(ws, id, { revision: 4, mode: "suggested" });
  assert.equal(response.candidates.length, 1); assert.equal(response.suggestedCourierId, rider); assert.equal(response.confirmationRequired, true); assert.equal(f.calls, 1);
  await assert.rejects(routing.recommend(outlet, id, { revision: 4, mode: "suggested" }), (e) => e.statusCode === 404);
  f.paid = false; await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "suggested" })); assert.equal(f.calls, 1);
  f.paid = true; f.claim = false; await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "suggested" }), (e) => e.statusCode === 429);
});

test("automatic recommendations enforce current strategy and suppress newly conflicting offers", async (t) => {
  const f = fixture(t), config = { ...settings.defaults, ...settings.smartDefaults, revision: 2, autoDispatch: true };
  settings.get.mock.mockImplementation(async () => config);
  t.mock.method(settings, "autoEnabled", () => true);
  await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" }, { automatic: true }), /strategy changed/);
  assert.equal(f.calls, 0);
  f.r.autoDispatchPaused = true;
  await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "smart" }, { automatic: true }), /paused/);
  f.r.autoDispatchPaused = false; f.conflicts = [{ activeCourierId: rider }];
  const result = await routing.recommend(ws, id, { revision: 4, mode: "smart" }, { automatic: true });
  assert.equal(result.candidates.length, 0); assert.equal(result.settingsRevision, 2);
});
test("empty shortlists skip Google, provider errors preserve manual dispatch and newly busy riders disappear", async (t) => {
  const f = fixture(t); f.shortlist = [];
  assert.equal((await routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" })).candidates.length, 0); assert.equal(f.calls, 0);
  f.shortlist = [f.c]; t.mock.method(google, "matrix", async () => { throw new Error("provider failure"); });
  const result = await routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" }); assert.equal(result.candidates.length, 0); assert.ok(result.warning);
  assert.equal(result.unavailableReason, "routing_unavailable");
  t.mock.method(google, "matrix", async () => { f.c.currentDeliveryId = id; return new Map([["0:0", { seconds: 1, metres: 1 }]]); });
  assert.equal((await routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" })).candidates.length, 0);
});

test("manual fallback deliveries still support recommendations without restarting automatic dispatch", async (t) => {
  const f = fixture(t); f.r.status = "awaiting_manual_assignment"; f.r.autoDispatchPaused = true;
  const result = await routing.recommend(ws, id, { revision: 4, mode: "smart" });
  assert.equal(result.candidates.length, 1); assert.equal(f.r.status, "awaiting_manual_assignment");
  await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "smart" }, { automatic: true }), /paused/);
});
test("settings saves use revision and workspace fences and reject concurrent initialization", async (t) => {
  env(t, "COMMERCE_DELIVERY_ENABLED", "true"); env(t, "COMMERCE_ROUTING_ENABLED", "true"); t.mock.method(readiness, "routingReady", async () => {});
  t.mock.method(repo.RoutingSettings, "findOneAndUpdate", (filter, update, options) => {
    assert.equal(String(filter.$and[0].workspaceId), ws); assert.equal(filter.$and[1].revision, 2); assert.equal(options.upsert, false);
    assert.equal(update.$inc.revision, 1); return { lean: async () => null };
  });
  await assert.rejects(settings.save(ws, { revision: 2, ...settings.defaults }), /changed/);
  t.mock.method(repo.RoutingSettings, "findOneAndUpdate", (filter, update, options) => {
    assert.deepEqual(filter.$and[1].revision, { $exists: false }); assert.equal(update.$setOnInsert.workspaceId, ws); assert.equal(options.upsert, true);
    assert.equal(options.writeConcern.w, "majority"); return { lean: async () => ({ ...update.$set, revision: 1 }) };
  });
  const saved = await settings.save(ws, { revision: 0, ...settings.defaults, routeShortlist: 7, offerSeconds: 35 }); assert.equal(saved.revision, 1); assert.equal(saved.routeShortlist, 7); assert.equal(saved.offerSeconds, 35);
  t.mock.method(repo.RoutingSettings, "findOneAndUpdate", () => ({ lean: async () => { throw Object.assign(new Error("duplicate key"), { code: 11000 }); } }));
  await assert.rejects(settings.save(ws, { revision: 0, ...settings.defaults }), (e) => e.statusCode === 409);
});

test("GPS JSON accepts ISO timestamps but retains strict numeric and coordinate validation", () => {
  const v = require("../delivery/validators"), input = { latitude: 0, longitude: 0, accuracy: 0, capturedAt: "2026-09-17T12:00:00.000Z" };
  assert.ok(v.parse(v.gps, input).capturedAt instanceof Date);
  for (const patch of [{ capturedAt: "yesterday" }, { capturedAt: 123 }, { latitude: "26" }, { longitude: 181 }, { accuracy: null }, { workspaceId: ws }]) assert.throws(() => v.parse(v.gps, { ...input, ...patch }));
});

test("route results are discarded when delivery revision or rider GPS changes during provider I/O", async (t) => {
  const f = fixture(t);
  t.mock.method(google, "matrix", async () => { f.r.revision++; return new Map(); });
  await assert.rejects(routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" }), /Delivery changed/);
  f.r.revision = 4;
  t.mock.method(google, "matrix", async () => { f.c.location.capturedAt = new Date(f.c.location.capturedAt.getTime() + 1); return new Map([["0:0", { seconds: 20, metres: 100 }]]); });
  const result = await routing.recommend(ws, id, { revision: 4, mode: "nearest_pickup" }); assert.equal(result.candidates.length, 0); assert.ok(result.warning);
});
