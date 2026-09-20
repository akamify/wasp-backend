require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { CommerceOrder: Order } = require("@infra/database/CommerceOrder");
const { CommerceEvent: Event } = require("@infra/database/CommerceEvent");
const { CommerceSession: Session } = require("@infra/database/CommerceSession");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const repo = require("../repositories/orders.repository");
const ws = "100000000000000000000001", id = "300000000000000000000001", now = new Date("2026-09-10T12:00:00Z");
test("order update query fences workspace, unpaid state, attempts and revision inside the supplied transaction", async (t) => {
  let query;
  t.mock.method(Order, "findOneAndUpdate", (filter, update, options) => { query = { filter, update, options }; return { select: () => ({ lean: async () => null }) }; });
  const session = { example: true };
  await repo.updateOrder(ws, id, 4, { reviewedBy: "merchant" }, session);
  assert.equal(String(query.filter.$and[0].workspaceId), ws); assert.equal(query.filter.$and[1].revision, 4);
  assert.equal(query.filter.$and[1].paymentStatus, "unpaid"); assert.equal(query.filter.$and[1].activeAttemptId, null);
  assert.equal(query.filter.$and[1].paidAttemptId, null); assert.equal(query.options.session, session); assert.equal(query.options.writeConcern, undefined);
});
test("transaction wrapper uses primary snapshot reads and majority journaled writes", async (t) => {
  let options;
  t.mock.method(mongoose.connection, "transaction", async (work, value) => { options = value; return work("session"); });
  assert.equal(await repo.transaction(async (session) => session), "session");
  assert.equal(options.readPreference, "primary"); assert.equal(options.readConcern.level, "snapshot"); assert.equal(options.writeConcern.w, "majority");
});
test("event completion and fulfillment consumption include owner/expiry guards on the transaction", async (t) => {
  let eventQuery, sessionQuery;
  t.mock.method(Event, "findOneAndUpdate", (filter, update, options) => { eventQuery = { filter, update, options }; return { lean: async () => null }; });
  t.mock.method(Session, "findOneAndUpdate", (filter, update, options) => { sessionQuery = { filter, update, options }; return { lean: async () => null }; });
  const session = { example: true };
  await repo.finishEvent({ workspaceId: ws, _id: id, leaseOwner: "worker" }, { status: "processed" }, session);
  assert.equal(eventQuery.filter.$and[1].leaseOwner, "worker"); assert.equal(eventQuery.filter.$and[1].status, "processing");
  assert.equal(eventQuery.options.session, session);
  await repo.consumeSession({ workspaceId: ws, _id: id, orderId: id }, now, session);
  assert.equal(sessionQuery.filter.$and[1].kind, "fulfillment"); assert.equal(sessionQuery.filter.$and[1].usedAt, null);
  assert.deepEqual(sessionQuery.filter.$and[1].expiresAt, { $gt: now }); assert.equal(sessionQuery.options.session, session);
});
test("Commerce tenant lookup requires the exact active WABA/phone pair and detects ambiguity with a bounded read", async (t) => {
  let query, limit;
  t.mock.method(WhatsAppCredentials, "find", (filter) => { query = filter; return { read: () => ({ limit: (value) => {
    limit = value; return { select: () => ({ lean: async () => [] }) };
  } }) }; });
  await repo.exactTenants("123", "456");
  assert.equal(query.businessAccountIdPlain, "123"); assert.equal(query.phoneNumberIdPlain, "456");
  assert.equal(query.status, "active"); assert.equal(limit, 2);
});
