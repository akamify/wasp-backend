require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { CommerceGatewayConnection } = require("@infra/database/CommerceGatewayConnection");
const { CommerceSession } = require("@infra/database/CommerceSession");
const { getIndexPlan } = require("../models/indexPlan");
const { assertGatewayReady } = require("../services/gatewayReadiness.service");
test("gateway activation fails closed without flags, encryption, supported topology and required indexes", async (t) => {
  const oldFlag = process.env.COMMERCE_GATEWAY_ENABLED, oldKey = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const connection = mongoose.connection, oldDb = connection.db;
  const stateDescriptor = Object.getOwnPropertyDescriptor(connection, "readyState");
  t.after(() => {
    oldFlag === undefined ? delete process.env.COMMERCE_GATEWAY_ENABLED : process.env.COMMERCE_GATEWAY_ENABLED = oldFlag;
    oldKey === undefined ? delete process.env.CREDENTIALS_ENCRYPTION_KEY : process.env.CREDENTIALS_ENCRYPTION_KEY = oldKey;
    connection.db = oldDb;
    if (stateDescriptor) Object.defineProperty(connection, "readyState", stateDescriptor); else delete connection.readyState;
  });
  process.env.COMMERCE_GATEWAY_ENABLED = "false";
  await assert.rejects(assertGatewayReady(), { statusCode: 503 });
  process.env.COMMERCE_GATEWAY_ENABLED = "true"; process.env.CREDENTIALS_ENCRYPTION_KEY = "bad";
  await assert.rejects(assertGatewayReady(), { statusCode: 503 });
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  Object.defineProperty(connection, "readyState", { configurable: true, value: 0 });
  await assert.rejects(assertGatewayReady(), { statusCode: 503 });
  Object.defineProperty(connection, "readyState", { configurable: true, value: 1 });
  let supported = false, missing = true, checks = 0;
  const plan = getIndexPlan({ CommerceGatewayConnection, CommerceSession });
  connection.db = {
    admin: () => ({ command: async () => { checks++; return supported ? { setName: "test-replica" } : {}; } }),
    collection: (name) => ({ listIndexes: () => ({ toArray: async () => missing ? []
      : plan.find((p) => p.collection === name).indexes.map((index) => ({ key: index.key, ...index.options })) }) }),
  };
  await assert.rejects(assertGatewayReady(), { statusCode: 503 });
  supported = true; await assert.rejects(assertGatewayReady(), { statusCode: 503 });
  missing = false; await assertGatewayReady();
  const verifiedChecks = checks; await assertGatewayReady(); assert.equal(checks, verifiedChecks);
});
