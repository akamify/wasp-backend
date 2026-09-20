require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const { CommerceProduct: Product, CommerceOrder: Order, CommerceInventoryReservation: Reservation, CommerceOutbox: Outbox } = require("../models");
const repo = require("../repositories/operations.repository");
const ws = "100000000000000000000001", id = "400000000000000000000001";
test("late stock allocation deducts available tracked stock atomically within its workspace transaction", async (t) => {
  t.mock.method(Product, "findOne", () => ({ session: () => ({ lean: async () => ({ inventoryOutletId: null }) }) }));
  let captured; const session = {};
  t.mock.method(Product, "findOneAndUpdate", (filter, update, options) => { captured = { filter, update, options }; return { lean: async () => null }; });
  await repo.allocateStock(ws, { productId: id, quantity: 2 }, new Date(), session);
  assert.equal(String(captured.filter.$and[0].workspaceId), ws); assert.equal(captured.filter.$and[1].trackInventory, true);
  assert.deepEqual(captured.filter.$and[1].$expr, { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, 2] });
  assert.deepEqual(captured.update.$inc, { stockOnHand: -2, revision: 1 }); assert.equal(captured.update.$set.syncStatus, "pending"); assert.equal(captured.options.session, session);
  assert.ok(captured.update.$set.syncNextAttemptAt instanceof Date);
  for (const key of Object.keys(captured.update.$set)) assert.ok(Product.schema.path(key), `Unknown product update field: ${key}`);
});
test("reservation and notification retries fence prior state and scope", async (t) => {
  const captured = [];
  for (const model of [Reservation, Outbox]) t.mock.method(model, "findOneAndUpdate", (filter, update, options) => { captured.push({ filter, update, options }); return { lean: async () => null }; });
  await repo.allocateReservation({ workspaceId: ws, _id: id }, new Date(), {});
  await repo.retryNotification({ workspaceId: ws, _id: id, startedAt: null }, "encrypted");
  assert.equal(captured[0].filter.$and[1].status, "released"); assert.equal(captured[1].filter.$and[1].status, "blocked");
  assert.equal(String(captured[1].filter.$and[0].workspaceId), ws); assert.equal(captured[1].update.$set.payloadEnc, "encrypted");
  assert.equal(captured[1].options.writeConcern.w, "majority");
});
test("inbox pagination pins customer, environment and original channel with a bounded indexed query", async (t) => {
  let captured = {};
  t.mock.method(Order, "find", (filter) => { captured.filter = filter; return { sort: (sort) => { captured.sort = sort; return { limit: (limit) => { captured.limit = limit; return { lean: async () => [] }; } }; } }; });
  await repo.inboxOrders(ws, { environment: "test", to: "919999999999", cursor: id, limit: 25 }, { wabaId: "123", phoneNumberId: "456" });
  assert.equal(String(captured.filter.$and[0].workspaceId), ws);
  assert.deepEqual(captured.filter.$and[1], { environment: "test", customerPhone: "919999999999", wabaId: "123", phoneNumberId: "456", _id: { $lt: id } });
  assert.equal(captured.limit, 26); assert.deepEqual(captured.sort, { _id: -1 });
  assert.ok(Order.schema.indexes().some(([keys]) => keys.workspaceId === 1 && keys.environment === 1 && keys.customerPhone === 1 && keys._id === -1));
});
