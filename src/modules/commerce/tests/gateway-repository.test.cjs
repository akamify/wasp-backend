require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CommerceGatewayConnection: Gateway } = require("@infra/database/CommerceGatewayConnection");
const { CommerceSession: Session } = require("@infra/database/CommerceSession");
const repo = require("../repositories/gateway.repository");
const ws = "100000000000000000000001", id = "300000000000000000000001", now = new Date("2026-09-10T12:00:00Z");

test("repository refresh writes fence workspace, revision, status and owner with atomic token persistence", async (t) => {
  const queries = [];
  t.mock.method(Gateway, "findOneAndUpdate", (filter, update, options) => {
    queries.push({ filter, update, options }); return { select: () => ({ lean: async () => ({ revision: 8 }) }) };
  });
  await repo.claimRefresh({ workspaceId: ws, _id: id, revision: 7 }, "worker-one", now);
  const claim = queries[0];
  assert.equal(String(claim.filter.$and[0].workspaceId), ws);
  assert.equal(claim.filter.$and[1].revision, 7); assert.equal(claim.filter.$and[1].refreshState, "idle");
  assert.equal(claim.filter.$and[1].active, true); assert.equal(claim.filter.$and[1].status, "connected");
  assert.equal(claim.update.$set.refreshLeaseOwner, "worker-one");
  await repo.update(ws, id, { revision: 8, refreshLeaseOwner: "worker-one", refreshState: "refreshing" },
    { accessTokenEnc: "new-encrypted-access", refreshTokenEnc: "new-encrypted-refresh", refreshState: "idle" });
  assert.equal(queries[1].filter.$and[1].refreshLeaseOwner, "worker-one");
  assert.equal(queries[1].update.$set.accessTokenEnc, "new-encrypted-access");
  assert.equal(queries[1].update.$set.refreshTokenEnc, "new-encrypted-refresh");
  assert.equal(queries[1].options.runValidators, true);
  assert.deepEqual(queries[1].options.writeConcern, { w: "majority", j: true, wtimeout: 10000 });
});
test("session consumption checks expiry independently of TTL and is workspace/user scoped", async (t) => {
  let query;
  t.mock.method(Session, "findOneAndUpdate", (filter, update) => { query = { filter, update }; return { lean: async () => null }; });
  await repo.consumeSession({ workspaceId: ws, _id: id, userId: "user-one" }, now);
  assert.equal(String(query.filter.$and[0].workspaceId), ws);
  assert.equal(query.filter.$and[1].userId, "user-one"); assert.equal(query.filter.$and[1].kind, "oauth");
  assert.equal(query.filter.$and[1].usedAt, null); assert.deepEqual(query.filter.$and[1].expiresAt, { $gt: now });
  assert.equal(query.update.$set.usedAt, now);
});
test("revocation mapping is restricted to verified account, OAuth client and mode with a timestamp cutoff", async (t) => {
  let query;
  t.mock.method(Gateway, "updateMany", async (filter, update) => { query = { filter, update }; });
  const timestamp = Math.floor(now.getTime() / 1000);
  await repo.revokeAccount("test", "client-one", "acc_one", timestamp);
  assert.equal(query.filter.environment, "test"); assert.equal(query.filter.oauthClientId, "client-one");
  assert.equal(query.filter.merchantAccountId, "acc_one"); assert.equal(query.filter.identityVerified, true);
  assert.equal(query.filter.authType, "oauth"); assert.equal(query.filter.oauthAuthorizedAt.$lt.getTime(), (timestamp + 1) * 1000);
  assert.equal(query.update.$set.active, false); assert.equal(query.update.$set.status, "revoked");
});
test("worker discovery bounds results and leases cannot be reclaimed after uncertain refresh", async (t) => {
  let filter, limit, update;
  t.mock.method(Gateway, "find", (query) => {
    filter = query; return { sort: () => ({ limit: (value) => { limit = value; return { select: () => ({ lean: async () => [] }) }; } }) };
  });
  await repo.dueRefreshes(now);
  assert.equal(limit, 10); assert.equal(filter.active, true); assert.equal(filter.refreshState, "idle");
  t.mock.method(Gateway, "updateMany", async (query, change) => { filter = query; update = change; });
  await repo.expireRefreshes(now);
  assert.equal(filter.refreshState, "refreshing"); assert.equal(filter.refreshLeaseUntil.$lte, now);
  assert.equal(update.$set.refreshState, "unknown"); assert.equal(update.$set.status, "error");
});
