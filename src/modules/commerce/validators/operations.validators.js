const Joi = require("joi");
const { parse, objectId, revisionBody } = require("./catalog.validators");
const fulfillment = Joi.object({ revision: revisionBody.extract("revision"), status: Joi.string().valid("confirmed", "processing", "ready", "out_for_delivery", "completed").required(),
  acknowledgeAttention: Joi.boolean().valid(true) });
const message = Joi.object({ kind: Joi.string().valid("product", "product_list", "catalog", "payment_request").required(),
  to: Joi.string().pattern(/^[1-9]\d{7,14}$/).required(), idempotencyKey: Joi.string().pattern(/^[A-Za-z0-9_-]{16,100}$/).required(),
  productIds: Joi.when("kind", { is: Joi.valid("product", "product_list"), then: Joi.array().items(objectId.required()).min(1).max(30).unique().required(), otherwise: Joi.forbidden() }),
  attemptId: Joi.when("kind", { is: "payment_request", then: objectId.required(), otherwise: Joi.forbidden() })
}).custom((v, h) => v.kind === "product" && v.productIds.length !== 1 ? h.error("any.invalid") : v);
module.exports = { parse, objectId, fulfillment, message };
