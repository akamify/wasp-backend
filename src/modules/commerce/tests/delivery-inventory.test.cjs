require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict");
const { Stock } = require("../delivery/models"), { change } = require("../delivery/inventory");
test("branch reservation, release and late allocation preserve original outlet and atomic stock guards", async (t) => {
  const ws = "100000000000000000000001", productId = "200000000000000000000001", original = "300000000000000000000001", selected = "400000000000000000000001", session = {};
  const calls = []; t.mock.method(Stock, "findOneAndUpdate", async (filter, update, options) => { calls.push({ filter, update, options }); return { _id: "stock" }; });
  const p = { _id: productId, inventoryOutletId: original };
  await change(ws, p, { outletId: selected, quantity: 2 }, "reserve", session);
  assert.equal(calls[0].filter.outletId, selected); assert.equal(calls[0].filter.workspaceId, ws); assert.equal(calls[0].filter.available, true);
  assert.deepEqual(calls[0].filter.$expr, { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, 2] });
  assert.equal(calls[0].options.session, session);
  await change(ws, p, { quantity: 2 }, "consume", session);
  assert.equal(calls[1].filter.outletId, original); assert.deepEqual(calls[1].update.$inc, { stockReserved: -2, stockOnHand: -2, revision: 1 });
  await change(ws, p, { quantity: 2 }, "release", session); assert.equal(calls[2].update.$inc.stockOnHand, undefined);
  await change(ws, p, { quantity: 2 }, "allocate", session); assert.equal(calls[3].filter.outletId, original); assert.equal(calls[3].update.$inc.stockOnHand, -2);
  await change(ws, { _id: productId }, { quantity: 2 }, "consume", session); assert.equal(calls.length, 4);
});
test("missing or insufficient branch stock fails without silently using another outlet", async (t) => {
  t.mock.method(Stock, "findOneAndUpdate", async () => null);
  await assert.rejects(change("workspace", { _id: "product", inventoryOutletId: "outlet" }, { quantity: 1 }, "reserve", {}), /Branch inventory/);
});

test("explicit migration moves stock once, preserves reservations and schedules a schema-valid catalog sync", async (t) => {
  const mongoose = require("mongoose"), { Outlet } = require("../delivery/models"), { CommerceProduct: Product } = require("../models");
  const ws = "100000000000000000000001", productId = "200000000000000000000001", outletId = "300000000000000000000001";
  const p = { _id: productId, workspaceId: ws, trackInventory: true, stockOnHand: 9, stockReserved: 3, available: true, revision: 1, inventoryOutletId: null };
  const session = {}, creates = [];
  t.mock.method(mongoose.connection, "transaction", async (work) => work(session));
  t.mock.method(Product, "findOne", () => ({ session: () => ({ lean: async () => ({ ...p }) }) }));
  t.mock.method(Outlet, "exists", (filter) => { assert.equal(filter.workspaceId, ws); return { session: async () => true }; });
  t.mock.method(Stock, "create", async (rows, options) => { assert.equal(options.session, session); creates.push(...rows); return rows; });
  t.mock.method(Product, "findOneAndUpdate", async (filter, update, options) => {
    assert.equal(filter.workspaceId, ws); assert.equal(filter.revision, p.revision); assert.equal(options.session, session);
    for (const key of Object.keys(update.$set)) assert.ok(Product.schema.path(key), `Unknown field: ${key}`);
    assert.equal(update.$set.syncStatus, "pending"); assert.ok(update.$set.syncNextAttemptAt instanceof Date);
    Object.assign(p, update.$set); p.revision++; return p;
  });
  await require("../delivery/inventory").migrate(ws, productId, outletId, 1);
  assert.equal(creates.length, 1); assert.equal(creates[0].stockReserved, 3); assert.equal(creates[0].stockOnHand, 9);
  await assert.rejects(require("../delivery/inventory").migrate(ws, productId, outletId, p.revision)); assert.equal(creates.length, 1);
});

test("branch adjustment updates aggregate stock by delta, never below existing reservations", async (t) => {
  const mongoose = require("mongoose"), { Outlet } = require("../delivery/models"), { CommerceProduct: Product } = require("../models");
  t.mock.method(mongoose.connection, "transaction", async (work) => work({}));
  t.mock.method(Product, "findOne", () => ({ session: () => ({ lean: async () => ({ inventoryOutletId: "original", revision: 2 }) }) }));
  t.mock.method(Outlet, "exists", () => ({ session: async () => true }));
  t.mock.method(Stock, "findOne", () => ({ session: () => ({ lean: async () => ({ _id: "stock", stockOnHand: 8, stockReserved: 3, revision: 4 }) }) }));
  t.mock.method(Stock, "updateOne", async () => ({ matchedCount: 1 }));
  let patch; t.mock.method(Product, "findOneAndUpdate", async (_filter, update) => { patch = update; return {}; });
  await require("../delivery/inventory").adjust("workspace", "outlet", "product", { revision: 4, stockOnHand: 10, available: true });
  assert.equal(patch.$inc.stockOnHand, 2); assert.ok(patch.$set.syncNextAttemptAt instanceof Date);
  for (const key of Object.keys(patch.$set)) assert.ok(Product.schema.path(key));
  await assert.rejects(require("../delivery/inventory").adjust("workspace", "outlet", "product", { revision: 4, stockOnHand: 2, available: true }));
});
