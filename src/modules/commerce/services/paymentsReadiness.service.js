const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const models = require("../models");
const { getIndexPlan, checkIndexes } = require("../models/indexPlan");
const paymentsEnabled = () => process.env.COMMERCE_PAYMENTS_ENABLED === "true";
const checkoutEnabled = () => paymentsEnabled() && process.env.COMMERCE_CHECKOUT_ENABLED === "true";
const liveEnabled = () => process.env.COMMERCE_LIVE_CHECKOUT_ENABLED === "true";
const nativeEnabled = () => checkoutEnabled() && liveEnabled() && process.env.COMMERCE_NATIVE_PAYMENTS_ENABLED === "true";
// Explicit operator acceptance per actual merchant/channel; a UI checkbox cannot establish eligibility.
const nativeAllowed = (ws, waba, phone, gateway) => nativeEnabled() &&
  (process.env.COMMERCE_NATIVE_ACCEPTED_BINDINGS || "").split(",").map((v) => v.trim()).includes(`${ws}:${waba}:${phone}:${gateway}`);
let checkedDatabase, checkedUntil = 0, pending;
async function assertPaymentsReady() {
  if (!paymentsEnabled()) throw new HttpError(503, "Commerce payment processing is not enabled.");
  if (Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY || "", "base64").length !== 32)
    throw new HttpError(503, "Commerce encryption is not configured.");
  if (mongoose.connection.readyState !== 1) throw new HttpError(503, "Commerce database is unavailable.");
  if (mongoose.connection.db === checkedDatabase && checkedUntil > Date.now()) return;
  if (!pending) pending = (async () => {
    const db = mongoose.connection.db, topology = await db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid") throw new HttpError(503, "Commerce payments require MongoDB transactions.");
    if ((await checkIndexes(db, getIndexPlan(models))).length) throw new HttpError(503, "Commerce payment indexes are not ready.");
    checkedDatabase = db; checkedUntil = Date.now() + 60000;
  })().catch((error) => { throw error instanceof HttpError ? error : new HttpError(503, "Commerce payment readiness could not be verified."); })
    .finally(() => { pending = undefined; });
  return pending;
}
module.exports = { paymentsEnabled, checkoutEnabled, liveEnabled, nativeEnabled, nativeAllowed, assertPaymentsReady };
