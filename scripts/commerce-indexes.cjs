require("module-alias/register");
const mongoose = require("mongoose");
const models = require("../src/modules/commerce/models");
const { getIndexPlan, checkIndexes, applyIndexes } = require("../src/modules/commerce/models/indexPlan");

async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length && !["--plan", "--check", "--apply"].includes(args[0]))) {
    throw new Error("Usage: npm run commerce:indexes -- [--plan|--check|--apply]");
  }
  const mode = args[0] || "--plan";
  const plan = getIndexPlan(models);
  if (mode === "--plan") {
    console.log(JSON.stringify({ mode: "plan", databaseConnected: false, collections: plan }, null, 2));
    return;
  }

  // Separate, explicit operator configuration. Never load the production .env.
  const uri = process.env.COMMERCE_MONGODB_URI;
  const dbName = process.env.COMMERCE_MONGODB_DB;
  if (!uri || !dbName) throw new Error("Set COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB explicitly.");
  let connection;
  try {
    connection = mongoose.createConnection(uri, {
      dbName, autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise();
    const topology = await connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid") {
      throw new Error("Commerce requires a MongoDB replica set or sharded cluster for transactions.");
    }
    if (mode === "--apply") await applyIndexes(connection.db, plan);
    const missing = await checkIndexes(connection.db, plan);
    console.log(JSON.stringify({ mode, database: dbName, missing }, null, 2));
    if (missing.length) process.exitCode = 1;
  } finally {
    if (connection) await connection.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Driver error text may contain credentials, index values or customer data.
    const safe = error.message.startsWith("Usage:") || error.message.startsWith("Set COMMERCE_")
      || error.message.startsWith("Commerce requires");
    console.error(safe ? error.message : "Commerce index operation failed. Check database access and index conflicts; no data cleanup was attempted.");
    process.exitCode = 1;
  });
}
module.exports = { main };

