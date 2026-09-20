const Joi = require("joi");
const { parse, objectId, revisionBody } = require("./catalog.validators");
const { parseRupees, MAX_MONEY } = require("../domain/money");
const { ORDER_TRANSITIONS } = require("../domain/states");
const revision = Joi.number().integer().min(1).max(1000000000).required();
const tax = Joi.number().integer().min(0).max(10000).allow(null);
const phone = Joi.string().pattern(/^[1-9]\d{7,14}$/);
const text = (max) => Joi.string().trim().min(1).max(max).pattern(/^[^\x00-\x1f\x7f]+$/);
const address = Joi.object({ name: text(150).required(), phone: phone.required(), line1: text(200).required(),
  line2: text(200).allow(""), city: text(100).required(), state: text(100).required(),
  postalCode: Joi.string().pattern(/^[1-9]\d{5}$/).required(), country: Joi.string().valid("IN").required(),
  location: Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(),
    accuracy: Joi.number().min(0).max(100000).allow(null), source: Joi.string().valid("gps", "map", "manual").required(), confirmed: Joi.boolean().valid(true).required(), confirmedAt: Joi.any().strip() }) });
const fulfillmentFields = { fulfillmentMethod: Joi.string().valid("pickup", "delivery").required(),
  address: Joi.when("fulfillmentMethod", { is: "delivery", then: address.required(), otherwise: Joi.forbidden() }) };
const fulfillment = Joi.object(fulfillmentFields);
const item = Joi.object({ sku: text(100).required(), quantity: Joi.number().integer().min(1).max(10000).required() });
const edit = Joi.object({ revision, ...fulfillmentFields,
  deliveryPrice: Joi.string().required().custom((value, helpers) => { try { parseRupees(value); return value; } catch { return helpers.error("any.invalid"); } }),
  deliveryTaxRateBps: tax.required(), items: Joi.array().items(item).min(1).max(100).unique("sku"),
});
const review = Joi.object({ revision, expectedTotalPaise: Joi.number().integer().min(0).max(MAX_MONEY).required(),
  acknowledgeWarnings: Joi.boolean().valid(true).required(),
  productRevisions: Joi.array().items(Joi.object({ productId: objectId.required(), revision })).min(1).max(100).unique("productId").required(),
});
const list = Joi.object({ environment: Joi.string().valid("test", "live").required(), status: Joi.string().valid(...Object.keys(ORDER_TRANSITIONS)),
  cursor: objectId, limit: Joi.number().integer().min(1).max(100).default(30) });
const eventList = Joi.object({ status: Joi.string().valid("pending", "processing", "processed", "dead_letter").default("dead_letter"),
  cursor: objectId, limit: Joi.number().integer().min(1).max(100).default(30) });
const settings = Joi.object({ revision: Joi.number().integer().min(0).max(1000000000).required(),
  enabled: Joi.boolean().required(), pickupEnabled: Joi.boolean().required(), deliveryEnabled: Joi.boolean().required(),
  pickupInstructions: Joi.string().max(1000).allow("").required(), testRecipients: Joi.array().items(phone).max(20).unique().required(),
}).custom((v, h) => v.enabled && !v.pickupEnabled && !v.deliveryEnabled ? h.error("any.invalid") : v);
const emptyBody = Joi.object({});
module.exports = { parse, objectId, revisionBody, address, fulfillment, edit, review, list, eventList, settings, emptyBody };
