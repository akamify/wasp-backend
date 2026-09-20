require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const branch = require("../delivery/branches"), repo = require("../delivery/repository"), service = require("../delivery/service"), settings = require("../delivery/routingSettings"), google = require("../delivery/googleRoutes");
const orders = require("../repositories/orders.repository"), { CommerceOrder } = require("../models");
const ws = "100000000000000000000001", id = "200000000000000000000001", a = "300000000000000000000001", b = "300000000000000000000002", product = "400000000000000000000001";
const query = (value) => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, session() { return this; }, lean: async () => value });
function fixture(t) {
  const f = { order: { _id: id, workspaceId: ws, revision: 1, fulfillmentMethod: "delivery", paymentStatus: "unpaid", status: "needs_review", items: [{ productId: product, quantity: 2 }], environment: "test", branchRoutingAttempts: 0 },
    outlets: [a, b].map((_id, i) => ({ _id, workspaceId: ws, name: _id, active: true, latitude: 26 + i * 0.001, longitude: 80, radiusMetres: 4000, prepMinutes: 15 })),
    stocks: [a, b].map((outletId) => ({ outletId, productId: product, available: true, stockOnHand: 4, stockReserved: 0 })), calls: 0, confirmed: true, routeError: false, notices: [], config: { ...settings.defaults, ...settings.smartDefaults, branchAutoSelect: true, revision: 1 } };
  t.mock.method(require("../delivery/readiness"), "routingReady", async () => {});
  t.mock.method(orders, "order", async (scope) => scope === ws ? structuredClone(f.order) : null);
  t.mock.method(orders, "workspaceActive", async () => true);
  t.mock.method(settings, "get", async () => f.config); t.mock.method(settings, "routingEnabled", () => true);
  t.mock.method(require("../delivery/domain"), "newEnabled", () => true);
  t.mock.method(service, "open", () => ({ location: { latitude: 26, longitude: 80, confirmedAt: f.confirmed ? new Date() : null } }));
  t.mock.method(service, "isOpen", (o) => !o.closed);
  t.mock.method(repo.Outlet, "find", (q) => { assert.equal(q.workspaceId, ws); return query(f.outlets); });
  t.mock.method(repo.Stock, "find", (q) => { assert.equal(q.workspaceId, ws); return query(f.stocks); });
  t.mock.method(google, "matrix", async (origins) => { f.calls++; if (f.routeError) throw new Error("Provider offline"); return new Map(origins.map((o, i) => [`${i}:0`, { seconds: 60, metres: o._id === a ? 2000 : 1000 }])); });
  return f;
}
test("branch ranking uses road distance after merchant/open/radius/stock eligibility", async (t) => {
  const f = fixture(t);
  let result = await branch.recommendations(ws, id, 1); assert.equal(result.suggestedOutletId, b);
  f.stocks[1].stockReserved = 3; result = await branch.recommendations(ws, id, 1); assert.equal(result.suggestedOutletId, a);
  f.outlets[0].closed = true; result = await branch.recommendations(ws, id, 1); assert.equal(result.suggestedOutletId, null);
  assert.equal(f.calls, 2);
});
test("branch selection rejects foreign, paid, stale and unconfirmed orders", async (t) => {
  const f = fixture(t);
  await assert.rejects(branch.recommendations(a, id, 1), /not found/);
  await assert.rejects(branch.recommendations(ws, id, 2), /locked or changed/);
  f.order.paymentStatus = "captured"; await assert.rejects(branch.recommendations(ws, id, 1)); f.order.paymentStatus = "unpaid";
  f.confirmed = false; await assert.rejects(branch.recommendations(ws, id, 1), /pin/);
  assert.equal(f.calls, 0);
});
test("duplicate product lines aggregate quantity and route outages do not invent a branch", async (t) => {
  const f = fixture(t);
  assert.equal(branch.stocked(a, [{ productId: product, quantity: 3 }, { productId: product, quantity: 2 }], f.stocks), false);
  f.routeError = true;
  await assert.rejects(branch.recommendations(ws, id, 1), /Provider offline/); assert.equal(f.order.revision, 1);
});
test("background branch selection uses a durable lease and only notifies once across competing workers", async (t) => {
  const f = fixture(t); let claimed = false;
  t.mock.method(CommerceOrder, "aggregate", () => ({ option: async () => [{ _id: id, workspaceId: ws, revision: 1 }] }));
  t.mock.method(CommerceOrder, "findOneAndUpdate", (_q, patch) => { if (claimed) return query(null); claimed = true; Object.assign(f.order, patch.$set); f.order.branchRoutingAttempts++; return query(structuredClone(f.order)); });
  t.mock.method(CommerceOrder, "updateOne", async (q, patch) => { if (q.revision !== f.order.revision || q.branchRoutingToken !== f.order.branchRoutingToken) return { modifiedCount: 0 }; Object.assign(f.order, patch.$set); f.order.revision++; return { modifiedCount: 1 }; });
  t.mock.method(repo, "transaction", (fn) => fn({}));
  t.mock.method(repo.RoutingSettings, "updateOne", async () => ({ modifiedCount: 1 }));
  t.mock.method(repo.Notice, "updateOne", async (_q, patch) => f.notices.push(patch.$setOnInsert));
  const result = await Promise.all([branch.run(), branch.run()]);
  assert.equal(result.reduce((n, r) => n + r.processed, 0), 1); assert.equal(f.notices.length, 1);
  assert.equal(f.order.recommendedOutletId, b); assert.equal(f.order.paymentStatus, "unpaid"); assert.equal(f.order.status, "needs_review");
});

test("branch provider failures retry twice then request manual selection without cancelling", async (t) => {
  const f = fixture(t); f.routeError = true;
  t.mock.method(CommerceOrder, "aggregate", () => ({ option: async () => [{ _id: id, workspaceId: ws, revision: f.order.revision }] }));
  t.mock.method(CommerceOrder, "findOneAndUpdate", (_q, patch) => { Object.assign(f.order, patch.$set); f.order.branchRoutingAttempts++; return query(structuredClone(f.order)); });
  t.mock.method(CommerceOrder, "updateOne", async (_q, patch) => { Object.assign(f.order, patch.$set); f.order.revision++; return { modifiedCount: 1 }; });
  t.mock.method(repo, "transaction", (fn) => fn({}));
  t.mock.method(repo.RoutingSettings, "updateOne", async () => ({ modifiedCount: 1 }));
  t.mock.method(repo.Notice, "updateOne", async (_q, patch) => f.notices.push(patch.$setOnInsert));
  assert.equal((await branch.run()).processed, 0); assert.equal((await branch.run()).processed, 0);
  assert.equal((await branch.run()).processed, 1); assert.equal(f.order.branchRoutingStatus, "manual");
  assert.equal(f.notices[0].kind, "branch_manual_selection_required"); assert.equal(f.order.status, "needs_review");
});
