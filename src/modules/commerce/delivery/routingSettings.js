const Joi = require("joi");
const { RoutingSettings } = require("./models");
const { byWorkspace } = require("../repositories/scope");
const { parse } = require("./validators");
const { enabled, fail } = require("./domain");
const defaults = Object.freeze({ pickupRadiusMetres: 8000, locationMaxAgeSeconds: 60, maxAccuracyMetres: 100, routeShortlist: 5, offerSeconds: 20 });
const strategies = ["SMART", "NEAREST_PICKUP", "NEAREST_CUSTOMER", "MANUAL"];
const smartDefaults = Object.freeze({ branchAutoSelect: false, batchPriority: "nearest_pickup", strategy: "SMART", autoDispatch: false, handoverSeconds: 120, allowedVehicles: ["motorcycle", "bicycle", "car"] });
const routingEnabled = () => enabled() && process.env.COMMERCE_ROUTING_ENABLED === "true";
const autoEnabled = () => routingEnabled() && require("./domain").newEnabled() && process.env.COMMERCE_AUTO_DISPATCH_ENABLED === "true";
const schema = Joi.object({ revision: Joi.number().integer().min(0).max(1e9).required(),
  branchAutoSelect: Joi.boolean(),
  batchPriority: Joi.string().valid("nearest_pickup", "existing_batch"),
  strategy: Joi.string().valid(...strategies), autoDispatch: Joi.boolean(), handoverSeconds: Joi.number().integer().min(0).max(1800),
  allowedVehicles: Joi.array().items(Joi.string().valid("motorcycle", "bicycle", "car")).min(1).max(3).unique(),
  pickupRadiusMetres: Joi.number().integer().min(100).max(50000).required(), locationMaxAgeSeconds: Joi.number().integer().min(15).max(300).required(),
  maxAccuracyMetres: Joi.number().integer().min(1).max(1000).required(), routeShortlist: Joi.number().integer().min(1).max(20).required(), offerSeconds: Joi.number().integer().min(10).max(120).required() });
const dto = (record) => ({ ...Object.fromEntries(Object.entries({ ...defaults, ...smartDefaults }).map(([key, value]) => [key, record?.[key] ?? value])), revision: record?.revision || 0 });
async function get(ws, session) {
  if (!routingEnabled()) return dto(null);
  return dto(await RoutingSettings.findOne(byWorkspace(ws)).session(session || null).lean());
}
async function save(ws, input) {
  if (!routingEnabled()) fail("Routing assistance is disabled.", 503);
  await require("./readiness").routingReady();
  const { revision, ...patch } = parse(schema, input);
  if (patch.strategy === "MANUAL" && patch.autoDispatch === true) fail("Choose a routing strategy before enabling automatic dispatch.", 400);
  if (patch.autoDispatch === true && !autoEnabled()) fail("Automatic dispatch is not enabled on this server.", 503);
  if (patch.autoDispatch === true && !process.env.COMMERCE_GOOGLE_ROUTES_API_KEY) fail("Configure Google Routes before enabling automatic dispatch.", 503);
  if (patch.autoDispatch === true) await require("./readiness").autoReady();
  try {
    const row = await RoutingSettings.findOneAndUpdate(byWorkspace(ws, { revision: revision || { $exists: false } }),
      { $set: patch, $inc: { revision: 1 }, ...(revision ? {} : { $setOnInsert: { workspaceId: ws } }) },
      { upsert: revision === 0, new: true, runValidators: true, setDefaultsOnInsert: false, writeConcern: { w: "majority", j: true, wtimeout: 10000 } }).lean();
    if (!row) fail("Dispatch settings changed. Refresh before saving.");
    return dto(row);
  } catch (e) { if (e.code === 11000) fail("Dispatch settings changed. Refresh before saving."); throw e; }
}
module.exports = { defaults, smartDefaults, strategies, schema, routingEnabled, autoEnabled, get, save };
