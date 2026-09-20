require("module-alias/register");
const mongoose = require("mongoose");
const { BusinessGroup } = require("../src/modules/business-groups/model");
const { CommerceOrder } = require("@infra/database/CommerceOrder");
const { CommercePayment } = require("@infra/database/CommercePayment");
const { getIndexPlan, applyIndexes, checkIndexes } = require("../src/modules/commerce/models/indexPlan");
const plan = [
  ...getIndexPlan({ BusinessGroup }),
  { collection: CommerceOrder.collection.collectionName, indexes: [{ key: { workspaceId: 1, environment: 1, receivedAt: 1 }, options: { name: "group_order_received" } }] },
  { collection: CommercePayment.collection.collectionName, indexes: [{ key: { workspaceId: 1, environment: 1, status: 1, createdAt: 1 }, options: { name: "group_payment_recorded" } }] },
];
async function main(args = process.argv.slice(2)) {
  const mode = args[0] || "--plan";
  if (args.length > 1 || !["--plan", "--check", "--apply"].includes(mode)) throw new Error("Usage: node scripts/business-group-indexes.cjs [--plan|--check|--apply]");
  if (mode === "--plan") return console.log(JSON.stringify(plan, null, 2));
  if (!process.env.COMMERCE_MONGODB_URI || !process.env.COMMERCE_MONGODB_DB) throw new Error("Set COMMERCE_MONGODB_URI and COMMERCE_MONGODB_DB explicitly");
  const connection = mongoose.createConnection(process.env.COMMERCE_MONGODB_URI, { dbName: process.env.COMMERCE_MONGODB_DB,
    autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    await connection.asPromise();
    if (mode === "--apply") await applyIndexes(connection.db, plan);
    const missing = await checkIndexes(connection.db, plan);
    console.log(JSON.stringify({ mode, missing }, null, 2));
    if (missing.length) process.exitCode = 1;
  } finally { await connection.close(); }
}
if (require.main === module) main().catch(() => { console.error("Business Group index operation failed. Check explicit database configuration and index conflicts. No indexes or data were removed."); process.exitCode = 1; });
module.exports = { main, plan };
