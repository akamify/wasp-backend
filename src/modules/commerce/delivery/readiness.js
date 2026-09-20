const mongoose = require("mongoose");
const { getIndexPlan, checkIndexes } = require("../models/indexPlan");
const { enabled, fail } = require("./domain");
const { Outlet, Courier, Delivery, Notice, Stock, RoutingSettings } = require("./models");
const basePlan = () => getIndexPlan({ Outlet, Courier, Delivery, Notice, Stock }).map((entry) => ({ ...entry, indexes: entry.indexes.filter((i) => !Object.values(i.key).includes("2dsphere") && !i.key.autoNextAttemptAt) }));
let until = 0, database;
async function ready() {
  if (!enabled()) fail("Manual delivery is not enabled.", 503);
  if (Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY || "", "base64").length !== 32 || mongoose.connection.readyState !== 1) fail("Delivery storage is not ready.", 503);
  const db = mongoose.connection.db;
  if (db === database && Date.now() < until) return;
  const topology = await db.admin().command({ hello: 1 });
  if ((!topology.setName && topology.msg !== "isdbgrid") || (await checkIndexes(db, basePlan())).length)
    fail("Delivery requires MongoDB transactions and its explicit index plan.", 503);
  database = db; until = Date.now() + 60000;
}
let routingUntil = 0, routingDatabase;
async function routingReady() {
  await ready();
  if (!require("./routingSettings").routingEnabled()) fail("Routing assistance is disabled.", 503);
  const db = mongoose.connection.db;
  if (db === routingDatabase && Date.now() < routingUntil) return;
  if ((await checkIndexes(db, getIndexPlan({ Courier, RoutingSettings }))).length) fail("Prepare the routing geospatial and settings indexes first.", 503);
  routingDatabase = db; routingUntil = Date.now() + 60000;
}
async function autoReady() {
  await routingReady();
  if (!require("./routingSettings").autoEnabled()) fail("Automatic dispatch is disabled.", 503);
  if ((await checkIndexes(mongoose.connection.db, getIndexPlan({ Delivery }))).length) fail("Prepare the automatic dispatch index first.", 503);
}
module.exports = { ready, routingReady, autoReady };
