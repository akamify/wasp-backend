const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { CommerceCatalogConnection } = require("@infra/database/CommerceCatalogConnection");
const { CommerceProduct } = require("@infra/database/CommerceProduct");
const { getIndexPlan, checkIndexes } = require("../models/indexPlan");

let checkedUntil = 0;
let checkedDatabase;
let pending;
function catalogEnabled() { return process.env.COMMERCE_CATALOG_ENABLED === "true"; }
async function assertCatalogReady() {
  if (!catalogEnabled()) throw new HttpError(503, "Commerce catalog is not enabled.");
  if (mongoose.connection.readyState !== 1) throw new HttpError(503, "Commerce database is unavailable.");
  if (Date.now() < checkedUntil && checkedDatabase === mongoose.connection.db) return;
  if (!pending) pending = (async () => {
    if (mongoose.connection.readyState !== 1) throw new HttpError(503, "Commerce database is unavailable.");
    const missing = await checkIndexes(mongoose.connection.db, getIndexPlan({ CommerceCatalogConnection, CommerceProduct }));
    if (missing.length) throw new HttpError(503, "Commerce indexes are not ready. Run the Commerce index check.");
    checkedDatabase = mongoose.connection.db;
    checkedUntil = Date.now() + 60000;
  })().catch((error) => {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Commerce index readiness could not be verified.");
  }).finally(() => { pending = undefined; });
  return pending;
}
module.exports = { catalogEnabled, assertCatalogReady };
