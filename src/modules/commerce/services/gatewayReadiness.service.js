const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { CommerceGatewayConnection } = require("@infra/database/CommerceGatewayConnection");
const { CommerceSession } = require("@infra/database/CommerceSession");
const { getIndexPlan, checkIndexes } = require("../models/indexPlan");
const { gatewayEnabled } = require("./gatewayConfig.service");
let checkedDatabase, checkedUntil = 0, pending;
async function assertGatewayReady() {
  if (!gatewayEnabled()) throw new HttpError(503, "Commerce gateways are not enabled.");
  if (Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY || "", "base64").length !== 32)
    throw new HttpError(503, "Commerce credential encryption is not configured.");
  if (mongoose.connection.readyState !== 1) throw new HttpError(503, "Commerce database is unavailable.");
  if (checkedDatabase === mongoose.connection.db && Date.now() < checkedUntil) return;
  if (!pending) pending = (async () => {
    const database = mongoose.connection.db;
    const topology = await database.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid")
      throw new HttpError(503, "Commerce gateways require a MongoDB replica set or sharded cluster.");
    const missing = await checkIndexes(database, getIndexPlan({ CommerceGatewayConnection, CommerceSession }));
    if (missing.length) throw new HttpError(503, "Commerce gateway indexes are not ready. Run the Commerce index check.");
    checkedDatabase = database; checkedUntil = Date.now() + 60000;
  })().catch((error) => {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Commerce gateway readiness could not be verified.");
  }).finally(() => { pending = undefined; });
  return pending;
}
module.exports = { assertGatewayReady };
