require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const auto = require("../delivery/autoDispatch"), settings = require("../delivery/routingSettings"), routing = require("../delivery/routing");
const repo = require("../delivery/repository"), service = require("../delivery/service"), readiness = require("../delivery/readiness");
const orders = require("../repositories/orders.repository"), { parse } = require("../delivery/validators");
const ws = "100000000000000000000001", id = "200000000000000000000001", rider = "300000000000000000000001", outlet = "400000000000000000000001";
function fixture(t) {
  const f = { enabled: true, active: true, claims: 0, routes: [], offers: [], notices: [],
    config: { ...settings.defaults, ...settings.smartDefaults, revision: 2, autoDispatch: true },
    r: { _id: id, workspaceId: ws, revision: 3, status: "awaiting_rider", autoAttempts: 0, autoNextAttemptAt: null },
    candidates: [{ courierId: rider, gpsAt: new Date(), vehicle: "car" }] };
  t.mock.method(settings, "autoEnabled", () => f.enabled);
  t.mock.method(settings, "get", async () => ({ ...f.config }));
  t.mock.method(readiness, "autoReady", async () => {});
  t.mock.method(orders, "workspaceActive", async () => f.active);
  t.mock.method(repo.Delivery, "aggregate", () => ({ option: async () => [structuredClone(f.r)] }));
  t.mock.method(repo.Delivery, "findOneAndUpdate", (filter, update, options) => ({ lean: async () => {
    assert.equal(filter.workspaceId, ws); assert.equal(filter.status, "awaiting_rider"); assert.equal(filter.autoDispatchPaused.$ne, true);
    assert.equal(options.writeConcern.w, "majority");
    if (filter.revision !== f.r.revision || f.r.autoNextAttemptAt > new Date()) return null;
    f.claims++; Object.assign(f.r, update.$set); f.r.autoAttempts += update.$inc.autoAttempts; return structuredClone(f.r);
  } }));
  t.mock.method(routing, "recommend", async (scope, key, input, options) => {
    if (f.providerFailure) throw new Error("private provider details");
    assert.equal(scope, ws); assert.equal(key, id); assert.equal(options.automatic, true); f.routes.push(input);
    return { candidates: f.candidates, settingsRevision: 2, expiresAt: new Date(Date.now() + 15000) };
  });
  t.mock.method(service, "dispatchFailure", async (_r, reason, terminal = true) => {
    if (terminal) Object.assign(f.r, { status: "awaiting_manual_assignment", autoDispatchPaused: true });
    f.notices.push([null, terminal ? "awaiting_manual_assignment" : "auto_dispatch_retry", reason]); return true;
  });
  t.mock.method(service, "offer", async (...args) => { f.offers.push(args); return {}; });
  t.mock.method(repo, "transaction", async (fn) => fn({}));
  t.mock.method(service, "required", async () => structuredClone(f.r));
  t.mock.method(service, "save", async (_kind, _r, patch) => Object.assign(f.r, patch));
  t.mock.method(repo, "notice", async (...args) => f.notices.push(args));
  return f;
}
test("SMART defaults are opt-in and all new settings reject unsafe or ambiguous values", () => {
  assert.equal(settings.smartDefaults.strategy, "SMART"); assert.equal(settings.smartDefaults.autoDispatch, false);
  for (const invalid of [{ autoDispatch: "true" }, { strategy: "random" }, { handoverSeconds: -1 }, { handoverSeconds: 1801 }, { handoverSeconds: 1.5 }, { allowedVehicles: [] }, { allowedVehicles: ["truck"] }, { allowedVehicles: ["car", "car"] }, { dispatchFence: 1 }])
    assert.throws(() => parse(settings.schema, { revision: 1, ...settings.defaults, ...invalid }));
  for (const strategy of settings.strategies) assert.equal(parse(settings.schema, { revision: 1, ...settings.defaults, strategy }).strategy, strategy);
});
test("settings cannot enable automation without the platform gate or with MANUAL", async (t) => {
  const original = { ...process.env };
  t.after(() => { for (const name of ["COMMERCE_DELIVERY_ENABLED", "COMMERCE_ROUTING_ENABLED", "COMMERCE_MANUAL_DISPATCH_ENABLED", "COMMERCE_AUTO_DISPATCH_ENABLED", "COMMERCE_GOOGLE_ROUTES_API_KEY"]) original[name] === undefined ? delete process.env[name] : process.env[name] = original[name]; });
  Object.assign(process.env, { COMMERCE_DELIVERY_ENABLED: "true", COMMERCE_ROUTING_ENABLED: "true", COMMERCE_MANUAL_DISPATCH_ENABLED: "true", COMMERCE_AUTO_DISPATCH_ENABLED: "false" });
  t.mock.method(readiness, "routingReady", async () => {});
  const input = { ...settings.defaults, revision: 1, autoDispatch: true, strategy: "SMART" };
  await assert.rejects(settings.save(ws, input), /not enabled on this server/);
  process.env.COMMERCE_AUTO_DISPATCH_ENABLED = "true";
  await assert.rejects(settings.save(ws, { ...input, strategy: "MANUAL" }), /Choose a routing strategy/);
  delete process.env.COMMERCE_GOOGLE_ROUTES_API_KEY;
  await assert.rejects(settings.save(ws, input), /Configure Google Routes/);
});
test("SMART formula handles prep dominating, rider dominating, ready orders, handover and missing routes", () => {
  const now = new Date(), pickup = { latitude: 26, longitude: 80 }, customer = { latitude: 26.01, longitude: 80 };
  const c = { _id: rider, location: { ...pickup, capturedAt: now, accuracy: 10 } };
  const matrix = new Map([["0:0", { seconds: 300, metres: 1000 }], ["1:1", { seconds: 600, metres: 2000 }]]);
  const rank = (wait, handover) => routing.rank({ car: [c] }, { car: matrix }, pickup, customer, "smart", new Date(now.getTime() + wait * 1000), now, handover);
  assert.equal(rank(900, 120)[0].scoreSeconds, 1620); assert.equal(rank(30, 120)[0].scoreSeconds, 1020);
  assert.equal(rank(-100, 0)[0].scoreSeconds, 900); matrix.delete("1:1"); assert.equal(rank(30, 120).length, 0);
});
test("automatic shortlist excludes wrong vehicles, previously offered riders and conflicting reservations before limit", () => {
  const p = routing.pipeline(ws, { outletId: outlet, autoExcludedIds: [rider] }, { latitude: 26, longitude: 80 }, { latitude: 26.01, longitude: 80 }, { ...settings.defaults, allowedVehicles: ["car"] }, "smart", new Date());
  assert.deepEqual(p[0].$geoNear.query.vehicle, { $in: ["car"] }); assert.equal(String(p[0].$geoNear.query._id.$nin[0]), rider);
  assert.equal(p[1].$lookup.foreignField, "activeCourierId"); assert.deepEqual(p[2].$match, { "conflicts.0": { $exists: false } }); assert.equal(p[3].$limit, 5);
  const plan = auto.pipeline(new Date()); assert.equal(plan[0].$match.status, "awaiting_rider"); assert.equal(plan[2].$lookup.pipeline[0].$match.autoDispatch, true); assert.equal(plan[4].$limit, 10);
  assert.ok(repo.Delivery.schema.indexes().some(([key]) => key.status === 1 && key.autoNextAttemptAt === 1));
});
test("platform OFF, merchant OFF, MANUAL and inactive merchants never request routes or offers", async (t) => {
  const f = fixture(t); f.enabled = false; assert.deepEqual(await auto.run(), { disabled: true }); assert.equal(f.claims, 0);
  f.enabled = true;
  for (const patch of [{ autoDispatch: false, strategy: "SMART" }, { autoDispatch: true, strategy: "MANUAL" }]) {
    Object.assign(f.config, patch); f.r.autoNextAttemptAt = null; assert.equal(await auto.dispatch(f.r), "disabled");
  }
  f.config.strategy = "SMART"; f.active = false; f.r.autoNextAttemptAt = null; assert.equal(await auto.dispatch(f.r), "disabled");
  assert.equal(f.routes.length, 0); assert.equal(f.offers.length, 0);
});
test("automatic strategies offer only the first eligible result with freshness and settings context", async (t) => {
  const f = fixture(t); f.candidates.push({ courierId: outlet, gpsAt: new Date(), vehicle: "car" });
  for (const [strategy, mode] of [["SMART", "smart"], ["NEAREST_PICKUP", "nearest_pickup"], ["NEAREST_CUSTOMER", "nearest_customer"]]) {
    f.config.strategy = strategy; f.r.autoNextAttemptAt = null;
    assert.equal(await auto.dispatch(f.r), "offered"); assert.equal(f.routes.at(-1).mode, mode);
    const [scope, deliveryId, input, actor, context] = f.offers.at(-1);
    assert.equal(scope, ws); assert.equal(deliveryId, id); assert.equal(input.courierId, rider); assert.equal(input.revision, 3);
    assert.equal(actor, "system:auto-dispatch"); assert.equal(context.settingsRevision, 2); assert.equal(context.vehicle, "car");
  }
  assert.equal(f.offers.length, 3);
});
test("two workers competing for a delivery claim create only one offer", async (t) => {
  const f = fixture(t), results = await Promise.all([auto.dispatch({ ...f.r }), auto.dispatch({ ...f.r })]);
  assert.deepEqual(results.sort(), ["claimed_elsewhere", "offered"]); assert.equal(f.claims, 1); assert.equal(f.offers.length, 1);
});
test("no candidates and provider failure leave a delayed durable retry without an invented offer", async (t) => {
  const f = fixture(t); f.candidates = []; assert.equal(await auto.dispatch(f.r), "awaiting_manual_assignment"); assert.equal(f.offers.length, 0);
  assert.ok(f.r.autoNextAttemptAt > new Date(Date.now() + 59000)); f.r.autoNextAttemptAt = null;
  f.providerFailure = true;
  assert.deepEqual(await auto.run(), { retry_pending: 1 }); assert.equal(f.offers.length, 0);
});
test("exhausted attempts pause and notify the merchant without further Google charges", async (t) => {
  const f = fixture(t); f.r.autoAttempts = auto.MAX_ATTEMPTS;
  assert.equal(await auto.dispatch(f.r), "exhausted"); assert.equal(f.r.autoDispatchPaused, true); assert.equal(f.routes.length, 0);
  assert.equal(f.notices.length, 1); assert.equal(f.notices[0][1], "awaiting_manual_assignment");
});

test("worker restart reclaims an expired lease and the final routing failure enters manual assignment", async (t) => {
  const f = fixture(t); f.r.autoAttempts = auto.MAX_ATTEMPTS - 1; f.r.autoNextAttemptAt = new Date(Date.now() - 1); f.providerFailure = true;
  assert.equal(await auto.dispatch(f.r), "awaiting_manual_assignment"); assert.equal(f.r.autoDispatchPaused, true);
  assert.equal(f.notices[0][1], "awaiting_manual_assignment"); assert.equal(f.offers.length, 0);
});
