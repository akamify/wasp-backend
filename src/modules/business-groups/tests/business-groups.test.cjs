require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BusinessGroup } = require("../model");
const { Workspace } = require("@infra/database/Workspace");
const { CommerceOrder } = require("@infra/database/CommerceOrder");
const { CommercePayment } = require("@infra/database/CommercePayment");
const { Contact } = require("@infra/database/Contact");
const { objectId, authorizedLinks, ownerOf, reportFilter } = require("../policy");
const service = require("../service");
const { report } = require("../reports");
const user = "100000000000000000000001", other = "100000000000000000000002", workspaceId = "a00000000000000000000001";
const workspace = (patch = {}) => ({ _id: objectId(workspaceId), ownerId: objectId(user), name: "Restaurant", isActive: true, status: "active", deletedAt: null, ...patch });
const link = (patch = {}) => ({ workspaceId: objectId(workspaceId), ownerId: objectId(user), requestId: "request-1", status: "active", requestedAt: new Date(), ...patch });
const group = (links = [link()]) => ({ _id: objectId(user), name: "Group", revision: 1, links });
function query(value) { const q = { select: () => q, sort: () => q, limit: () => q, maxTimeMS: () => q, lean: async () => typeof value === "function" ? value() : value }; return q; }

test("scope excludes pending, revoked, inactive and transferred workspaces; legacy owner precedence matches existing policy", () => {
  assert.equal(ownerOf(workspace({ ownerUserId: other })), other);
  assert.equal(authorizedLinks(group(), [workspace()]).length, 1);
  for (const status of ["pending", "revoked", "rejected"]) assert.equal(authorizedLinks(group([link({ status })]), [workspace()]).length, 0);
  for (const patch of [{ ownerUserId: other }, { status: "suspended" }, { isActive: false }, { deletedAt: new Date() }]) assert.equal(authorizedLinks(group(), [workspace(patch)]).length, 0);
  assert.deepEqual(authorizedLinks(group(), []), []);
});
test("filters reject invalid/injected identifiers, ambiguous dates, invalid leap days, reversed ranges and oversized reports", () => {
  for (const id of [undefined, "bad", { $ne: null }, [user]]) assert.throws(() => objectId(id), { statusCode: 400 });
  for (const input of [{ environment: "all" }, { environment: ["live"] }, { from: "2026-02-29" }, { from: "yesterday" }, { from: "2026-09-20", to: "2026-09-19" }, { from: "2020-01-01", to: "2026-01-01" }, { after: "bad" }]) assert.throws(() => reportFilter(input), { statusCode: 400 });
  const f = reportFilter({ from: "2024-02-29", to: "2024-03-01", environment: "test" });
  assert.equal(f.end - f.start, 86400000); assert.equal(f.environment, "test");
  const defaults = reportFilter({}, new Date("2026-09-19T20:00:00Z"));
  assert.equal(defaults.end.toISOString(), "2026-09-20T00:00:00.000Z"); assert.equal(defaults.end - defaults.start, 30 * 86400000);
});
test("same-owner connection is active, cross-owner pending, and both use revision compare-and-swap", async (t) => {
  let targetOwner = user, written;
  t.mock.method(BusinessGroup, "findById", () => query(group([])));
  t.mock.method(Workspace, "findById", () => query(workspace({ ownerId: targetOwner })));
  t.mock.method(BusinessGroup, "findOneAndUpdate", (filter, update) => { assert.equal(filter.revision, 1); written = update.$set.links[0]; return query(group([written])); });
  assert.equal((await service.requestLink(user, workspaceId)).status, "active"); assert.equal(String(written.decidedBy), user);
  targetOwner = other; assert.equal((await service.requestLink(user, workspaceId)).status, "pending"); assert.equal(written.decidedBy, null);
});
test("duplicate ID casing cannot create a second grant and concurrent edits fail with conflict", async (t) => {
  let existing = group();
  t.mock.method(BusinessGroup, "findById", () => query(existing));
  t.mock.method(Workspace, "findById", () => query(workspace()));
  t.mock.method(BusinessGroup, "findOneAndUpdate", () => query(null));
  await assert.rejects(service.requestLink(user, workspaceId.toUpperCase()), { statusCode: 409 });
  existing = group([]); await assert.rejects(service.requestLink(user, workspaceId), { statusCode: 409 });
});
test("group cap is enforced without truncating existing links", async (t) => {
  t.mock.method(BusinessGroup, "findById", () => query(group(Array.from({ length: 100 }, (_, i) => link({ workspaceId: objectId((i + 100).toString(16).padStart(24, "0")) })))));
  t.mock.method(Workspace, "findById", () => query(workspace()));
  await assert.rejects(service.requestLink(user, workspaceId), { statusCode: 409 });
});
test("concurrent link requests cannot overwrite each other", async (t) => {
  let stored = group([]);
  t.mock.method(BusinessGroup, "findById", () => query({ ...stored, links: [...stored.links] }));
  t.mock.method(Workspace, "findById", (id) => query(workspace({ _id: id })));
  t.mock.method(BusinessGroup, "findOneAndUpdate", (filter, update) => query(() => {
    if (filter.revision !== stored.revision) return null;
    stored = { ...stored, links: update.$set.links, revision: stored.revision + 1 }; return stored;
  }));
  const results = await Promise.allSettled([service.requestLink(user, workspaceId), service.requestLink(user, "b00000000000000000000001")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.statusCode, 409);
  assert.equal(stored.links.length, 1);
});
test("simultaneous group creation returns a recoverable conflict and invalid names never write", async (t) => {
  let writes = 0;
  t.mock.method(BusinessGroup, "findOneAndUpdate", () => query(() => { writes++; throw Object.assign(new Error("duplicate"), { code: 11000 }); }));
  for (const name of [null, " ", "a".repeat(101), { name: "bad" }]) await assert.rejects(service.saveGroup(user, name), { statusCode: 400 });
  assert.equal(writes, 0);
  await assert.rejects(service.saveGroup(user, "Group"), { statusCode: 409 });
});
test("only current target owner may approve; group owner can revoke; stale request cannot be accepted twice", async (t) => {
  let changed = true;
  t.mock.method(Workspace, "findById", () => query(workspace({ ownerId: other })));
  t.mock.method(BusinessGroup, "findOneAndUpdate", (filter, update) => {
    assert.equal(filter.links.$elemMatch.requestId, "request-1");
    if (update.$set["links.$.status"] === "active") {
      assert.deepEqual(filter.links.$elemMatch.status.$in, ["pending"]);
      assert.equal(String(filter.links.$elemMatch.ownerId), other);
    }
    return query(changed ? group() : null);
  });
  await assert.rejects(service.decideLink(user, user, workspaceId, "request-1", "approve"), { statusCode: 403 });
  assert.equal((await service.decideLink(other, user, workspaceId, "request-1", "approve")).success, true);
  assert.equal((await service.decideLink(user, user, workspaceId, "request-1", "revoke")).success, true);
  changed = false; await assert.rejects(service.decideLink(other, user, workspaceId, "request-1", "approve"), { statusCode: 409 });
});
test("inbox is available only to the current owner, not ordinary workspace members", async (t) => {
  t.mock.method(Workspace, "findById", () => query(workspace({ ownerId: other })));
  await assert.rejects(service.inbox(user, workspaceId), { statusCode: 404 });
});
test("report uses only active grants, filters environment/dates before aggregation, bounds output and never projects private customer data", async (t) => {
  const g = group([link(), link({ workspaceId: objectId("b00000000000000000000001"), status: "pending" })]);
  t.mock.method(BusinessGroup, "findById", () => query(g));
  t.mock.method(Workspace, "find", () => query([workspace()]));
  const pipelines = [];
  for (const model of [CommerceOrder, CommercePayment, Contact]) t.mock.method(model, "aggregate", (pipeline) => ({ option: async (options) => {
    assert.equal(options.maxTimeMS, 10000); pipelines.push({ model, pipeline }); return [];
  } }));
  t.mock.method(CommerceOrder, "find", (filter) => {
    assert.equal(filter.environment, "test"); assert.equal(filter.workspaceId.$in.length, 1);
    const q = query([]); q.select = (fields) => { assert.doesNotMatch(fields, /\b(customer\w*|\w*Enc|gateway\w*)\b/); return q; };
    q.limit = (n) => { assert.equal(n, 26); return q; }; return q;
  });
  const result = await report(user, { environment: "test", from: "2026-09-01", to: "2026-09-20" });
  assert.equal(result.rows.length, 1); assert.equal(result.uniqueOrderCustomers, 0);
  for (const { pipeline } of pipelines) assert.deepEqual(pipeline[0].$match.workspaceId.$in.map(String), [workspaceId]);
  const paid = pipelines.find((p) => p.model === CommercePayment).pipeline[0].$match;
  assert.equal(paid.status, "captured"); assert.equal(paid.environment, "test"); assert.ok(paid.createdAt.$gte); assert.equal(paid.capturedAt, undefined);
});
test("revocation while aggregation runs discards the report", async (t) => {
  let reads = 0;
  t.mock.method(BusinessGroup, "findById", () => query(() => (++reads === 1 ? group() : { ...group([]), revision: 2 })));
  t.mock.method(Workspace, "find", () => query([workspace()]));
  for (const model of [CommerceOrder, CommercePayment, Contact]) t.mock.method(model, "aggregate", () => ({ option: async () => [] }));
  t.mock.method(CommerceOrder, "find", () => query([]));
  await assert.rejects(report(user, {}), { statusCode: 409 });
});
test("empty group produces no unscoped business queries", async (t) => {
  t.mock.method(BusinessGroup, "findById", () => query(group([])));
  t.mock.method(Workspace, "find", () => query([]));
  for (const model of [CommerceOrder, CommercePayment, Contact]) t.mock.method(model, "aggregate", () => { throw new Error("Unexpected unscoped query"); });
  const result = await report(user, {}); assert.deepEqual(result.rows, []); assert.deepEqual(result.orders, []);
});
test("four linked panels return a combined order list and per-panel metrics; pending fifth panel is excluded", async (t) => {
  const ids = [1, 2, 3, 4, 5].map((n) => objectId(`a0000000000000000000000${n}`));
  const workspaces = ids.map((_id, i) => workspace({ _id, name: `Panel ${i + 1}` }));
  t.mock.method(BusinessGroup, "findById", () => query(group(ids.map((id, i) => link({ workspaceId: id, status: i === 4 ? "pending" : "active" })))));
  t.mock.method(Workspace, "find", () => query(workspaces));
  const activeIds = ids.slice(0, 4);
  const expectedOrders = activeIds.map((workspaceId, i) => ({ _id: objectId(`b0000000000000000000000${i + 1}`), workspaceId, orderNumber: `AWC-${i + 1}` }));
  const checkScope = (filter) => assert.deepEqual(filter.workspaceId.$in.map(String), activeIds.map(String));
  t.mock.method(CommerceOrder, "find", (filter) => { checkScope(filter); return query(expectedOrders); });
  t.mock.method(CommerceOrder, "aggregate", (pipeline) => ({ option: async () => {
    checkScope(pipeline[0].$match);
    return pipeline.at(-1).$count ? [{ count: 3 }] : activeIds.map((_id) => ({ _id, orders: 1, paidOrders: 1, completedOrders: 0 }));
  } }));
  t.mock.method(CommercePayment, "aggregate", (pipeline) => ({ option: async () => {
    checkScope(pipeline[0].$match);
    return activeIds.map((workspaceId) => ({ _id: { workspaceId, currency: "INR" }, capturedPaise: 10000, refundedPaise: 500 }));
  } }));
  t.mock.method(Contact, "aggregate", (pipeline) => ({ option: async () => { checkScope(pipeline[0].$match); return [{ count: 8 }]; } }));
  const result = await report(user, { environment: "live" });
  assert.equal(result.rows.length, 4); assert.equal(result.orders.length, 4);
  assert.deepEqual(result.orders.map((o) => o.orderNumber), ["AWC-1", "AWC-2", "AWC-3", "AWC-4"]);
  assert.equal(result.rows.reduce((n, r) => n + r.orders, 0), 4);
  assert.equal(result.rows.reduce((n, r) => n + r.payments[0].capturedPaise, 0), 40000);
  assert.equal(result.uniqueOrderCustomers, 3); assert.equal(result.uniqueContactNumbers, 8);
});
