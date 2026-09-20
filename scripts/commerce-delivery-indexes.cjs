require("module-alias/register");
const mongoose = require("mongoose");
const { Outlet, Courier, Delivery, Notice, Stock, RoutingSettings, Zone, Trip } = require("../src/modules/commerce/delivery/models");
const { getIndexPlan, checkIndexes, applyIndexes } = require("../src/modules/commerce/models/indexPlan");
async function main() {
  const args = process.argv.slice(2), mode = args[0] || "--plan";
  if (args.length > 1 || !["--plan", "--check", "--apply"].includes(mode)) throw new Error("Invalid mode");
  const plan = getIndexPlan({ Outlet, Courier, Delivery, Notice, Stock, RoutingSettings, Zone, Trip });
  if (mode === "--plan") { console.log(JSON.stringify({ databaseConnected: false, collections: plan }, null, 2)); return; }
  if (!process.env.COMMERCE_MONGODB_URI || !process.env.COMMERCE_MONGODB_DB) throw new Error("Explicit database configuration required");
  try {
    await mongoose.connect(process.env.COMMERCE_MONGODB_URI, { dbName: process.env.COMMERCE_MONGODB_DB, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db, hello = await db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("Transactions required");
    if (mode === "--apply") await applyIndexes(db, plan);
    const missing = await checkIndexes(db, plan); console.log(JSON.stringify({ mode, missing }, null, 2)); if (missing.length) process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
}
main().catch(() => { console.error("Delivery index operation failed. Verify mode, explicit database configuration and index conflicts. No data cleanup was attempted."); process.exitCode = 1; });
