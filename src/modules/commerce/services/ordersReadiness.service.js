const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const models = require("../models");
const { getIndexPlan, checkIndexes } = require("../models/indexPlan");
const ordersEnabled = () => process.env.COMMERCE_ORDERS_ENABLED === "true";
let checkedDatabase, checkedUntil = 0, pending;
async function assertOrdersReady() {
  if (!ordersEnabled()) throw new HttpError(503, "Commerce orders are not enabled.");
  if (Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY || "", "base64").length !== 32)
    throw new HttpError(503, "Commerce encryption is not configured.");
  if (mongoose.connection.readyState !== 1) throw new HttpError(503, "Commerce database is unavailable.");
  if (mongoose.connection.db === checkedDatabase && checkedUntil > Date.now()) return;
  if (!pending) pending = (async () => {
    const db = mongoose.connection.db;
    const topology = await db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid") throw new HttpError(503, "Commerce orders require MongoDB transactions.");
    const selected = Object.fromEntries(["CommerceOrder", "CommerceEvent", "CommerceProduct", "CommerceCatalogConnection", "CommerceSettings", "CommerceSession"].map((name) => [name, models[name]]));
    if ((await checkIndexes(db, getIndexPlan(selected))).length) throw new HttpError(503, "Commerce order indexes are not ready.");
    checkedDatabase = db; checkedUntil = Date.now() + 60000;
  })().catch((error) => {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Commerce order readiness could not be verified.");
  }).finally(() => { pending = undefined; });
  return pending;
}
module.exports = { ordersEnabled, assertOrdersReady };
