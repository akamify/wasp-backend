const Joi = require("joi");
const { parse, objectId } = require("../validators/orders.validators");
const revision = Joi.number().integer().min(1).max(1e9).required();
const location = Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(),
  accuracy: Joi.number().min(0).max(100000).allow(null).default(null), source: Joi.string().valid("gps", "map", "manual").required(),
  confirmed: Joi.boolean().valid(true).required() });
const outlet = Joi.object({ name: Joi.string().trim().max(150).required(), address: Joi.string().trim().max(1000).required(), latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(), active: Joi.boolean().required(), prepMinutes: Joi.number().integer().min(1).max(240).required(), radiusMetres: Joi.number().integer().min(100).max(50000).required(),
  openingHours: Joi.array().max(7).unique("day").items(Joi.object({ day: Joi.number().integer().min(0).max(6).required(), open: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required(), close: Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).required() }).custom((v, h) => v.open < v.close ? v : h.error("any.invalid"))).required() });
const courier = Joi.object({ address: Joi.string().trim().max(1000).allow(""), batchCapacity: Joi.number().integer().min(1).max(30), batchMode: Joi.string().valid("fixed_zone", "first_customer"), batchRadiusMetres: Joi.number().integer().min(100).max(50000), pickupRadiusMetres: Joi.number().integer().min(100).max(50000), batchAutoAssign: Joi.boolean(), email: Joi.string().email().lowercase().required(), name: Joi.string().trim().max(150).required(), phone: Joi.string().pattern(/^[1-9]\d{7,14}$/).required(),
  vehicle: Joi.string().valid("motorcycle", "bicycle", "car").required(), active: Joi.boolean().required(), allowedOutletIds: Joi.array().items(objectId).min(1).max(100).unique().required() });
const page = Joi.object({ cursor: objectId, limit: Joi.number().integer().min(1).max(50).default(25), environment: Joi.string().valid("test", "live").default("live") });
module.exports = { parse, objectId, revision, location, outlet, courier, page,
  acceptance: Joi.object({ revision, outletId: objectId, selection: Joi.string().valid("manual", "nearest").default("manual"), prepMinutes: Joi.number().integer().min(1).max(240).required() }).custom((v, h) => v.selection === "manual" && !v.outletId ? h.error("any.invalid") : v),
  offer: Joi.object({ revision, courierId: objectId.required(), idempotencyKey: Joi.string().guid({ version: "uuidv4" }).required() }),
  action: Joi.object({ revision, action: Joi.string().valid("prepare", "ready", "accept", "decline", "arrived_at_pickup", "picked_up", "out_for_delivery", "delivered", "reassign", "exception", "cancel", "override", "pause_auto", "resume_auto").required(),
    reason: Joi.string().trim().min(5).max(500), pin: Joi.string().pattern(/^\d{6}$/) }),
  gps: Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(), accuracy: Joi.number().min(0).max(100000).required(), capturedAt: Joi.string().isoDate().required().custom((value) => new Date(value)) }),
};
