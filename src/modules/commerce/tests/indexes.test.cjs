require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const models = require("../models");
const { getIndexPlan, indexMatches, checkIndexes, applyIndexes } = require("../models/indexPlan");
const plan = getIndexPlan(models);
const indexes = (name) => plan.find((entry) => entry.collection === models[name].collection.collectionName).indexes;
const unique = (name, key) => indexes(name).find((entry) => JSON.stringify(entry.key) === JSON.stringify(key) && entry.options.unique);

test("indexes isolate products, inbound deduplication and idempotency by workspace", () => {
  assert.ok(unique("CommerceProduct", { workspaceId: 1, catalogConnectionId: 1, sku: 1 }));
  assert.ok(unique("CommerceOrder", { workspaceId: 1, wabaId: 1, inboundMessageId: 1 }));
  assert.ok(unique("CommerceCheckoutAttempt", { workspaceId: 1, idempotencyKey: 1 }));
  assert.ok(unique("CommerceEvent", { workspaceId: 1, eventKey: 1 }));
});
test("only one active checkout or gateway can exist in their ownership scope", () => {
  assert.deepEqual(unique("CommerceCheckoutAttempt", { orderId: 1 }).options.partialFilterExpression, { active: true });
  assert.deepEqual(unique("CommerceGatewayConnection", { workspaceId: 1, provider: 1, environment: 1 }).options.partialFilterExpression, { active: true });
  assert.deepEqual(unique("CommerceGatewayConnection", { provider: 1, environment: 1, merchantAccountId: 1 }).options.partialFilterExpression,
    { merchantAccountId: { $type: "string" }, active: true, identityVerified: true });
  assert.ok(unique("CommerceGatewayConnection", { keyFingerprint: 1 }));
  assert.ok(unique("CommercePayment", { gatewayConnectionId: 1, providerPaymentId: 1 }));
  assert.ok(unique("CommerceRefund", { gatewayConnectionId: 1, providerRefundId: 1 }));
});
test("only ephemeral sessions use TTL, reservations and payment history are retained", () => {
  const ttlCollections = plan.filter((entry) => entry.indexes.some((index) => index.options.expireAfterSeconds != null));
  assert.equal(ttlCollections.length, 1);
  assert.equal(ttlCollections[0].collection, models.CommerceSession.collection.collectionName);
});
test("index comparison preserves compound key order and checks constraint semantics", () => {
  const expected = { key: { workspaceId: 1, environment: 1 }, options: { unique: true, partialFilterExpression: { active: true, identityVerified: true } } };
  const good = { key: expected.key, unique: true, partialFilterExpression: { identityVerified: true, active: true } };
  assert.equal(indexMatches(good, expected), true);
  for (const patch of [{ key: { environment: 1, workspaceId: 1 } }, { unique: false }, { sparse: true }, { hidden: true },
    { partialFilterExpression: { active: true } }, { expireAfterSeconds: 0 }, { collation: { locale: "en", strength: 2 } }]) {
    assert.equal(indexMatches({ ...good, ...patch }, expected), false);
  }
});
test("checking indexes is read only and missing collections are reported", async () => {
  const one = [plan[0]];
  const db = { collection: () => ({ listIndexes: () => ({ toArray: async () => { throw Object.assign(new Error("missing"), { code: 26 }); } }) }) };
  assert.equal((await checkIndexes(db, one)).length, one[0].indexes.length);
  const validDb = { collection: () => ({ listIndexes: () => ({ toArray: async () => one[0].indexes.map((entry) => ({ key: entry.key, ...entry.options })) }) }) };
  assert.deepEqual(await checkIndexes(validDb, one), []);
});
test("index apply issues only createIndex and stops on duplicate data without cleanup", async () => {
  const calls = [];
  const db = { collection: (collection) => ({ createIndex: async (key, options) => { calls.push({ collection, key, options }); } }) };
  await applyIndexes(db, plan);
  assert.equal(calls.length, plan.reduce((total, entry) => total + entry.indexes.length, 0));
  let count = 0;
  const error = Object.assign(new Error("duplicate"), { code: 11000 });
  const brokenDb = { collection: () => ({ createIndex: async () => { count++; throw error; } }) };
  await assert.rejects(applyIndexes(brokenDb, plan), { code: 11000 });
  assert.equal(count, 1);
});

