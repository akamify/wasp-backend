require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const models = require("../models");
const { getIndexPlan } = require("../models/indexPlan");
const { assertOrdersReady } = require("../services/ordersReadiness.service");
test("order readiness requires explicit enablement, encryption, transaction topology and all relevant indexes", async (t) => {
  const oldFlag = process.env.COMMERCE_ORDERS_ENABLED, oldKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const connection = mongoose.connection, oldDb = connection.db, stateDescriptor = Object.getOwnPropertyDescriptor(connection, "readyState");
  t.after(() => {
    oldFlag === undefined ? delete process.env.COMMERCE_ORDERS_ENABLED : process.env.COMMERCE_ORDERS_ENABLED = oldFlag;
    oldKey === undefined ? delete process.env.CREDENTIALS_ENCRYPTION_KEY : process.env.CREDENTIALS_ENCRYPTION_KEY = oldKey;
    connection.db = oldDb;
    if (stateDescriptor) Object.defineProperty(connection, "readyState", stateDescriptor); else delete connection.readyState;
  });
  process.env.COMMERCE_ORDERS_ENABLED = "false"; await assert.rejects(assertOrdersReady(), { statusCode: 503 });
  process.env.COMMERCE_ORDERS_ENABLED = "true"; process.env.CREDENTIALS_ENCRYPTION_KEY = "invalid";
  await assert.rejects(assertOrdersReady(), { statusCode: 503 });
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  Object.defineProperty(connection, "readyState", { configurable: true, value: 1 });
  let supported = false, missing = true;
  const plan = getIndexPlan(models);
  connection.db = {
    admin: () => ({ command: async () => supported ? { setName: "example" } : {} }),
    collection: (name) => ({ listIndexes: () => ({ toArray: async () => missing ? []
      : plan.find((p) => p.collection === name).indexes.map((index) => ({ key: index.key, ...index.options })) }) }),
  };
  await assert.rejects(assertOrdersReady(), { statusCode: 503 }); supported = true;
  await assert.rejects(assertOrdersReady(), { statusCode: 503 }); missing = false;
  await assertOrdersReady();
});
