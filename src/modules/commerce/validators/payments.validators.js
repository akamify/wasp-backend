const Joi = require("joi");
const { parse, objectId, revisionBody, emptyBody, eventList } = require("./orders.validators");
const checkout = Joi.object({ revision: revisionBody.extract("revision"), gatewayConnectionId: objectId.required(),
  mode: Joi.string().valid("razorpay_payment_link", "whatsapp_native").default("razorpay_payment_link"),
  idempotencyKey: Joi.string().pattern(/^[A-Za-z0-9_-]{16,100}$/).required() });
const list = Joi.object({ environment: Joi.string().valid("test", "live").required(),
  cursor: objectId, limit: Joi.number().integer().min(1).max(100).default(25) });
const settings = Joi.object({ revision: Joi.number().integer().min(1).max(1000000000).required(),
  liveCheckoutEnabled: Joi.boolean().required(), reservationMinutes: Joi.number().integer().min(5).max(120).required() });
const identity = Joi.object({ revision: revisionBody.extract("revision"), oauthGatewayConnectionId: objectId.required(),
  providerPaymentId: Joi.string().pattern(/^pay_[A-Za-z0-9]{1,80}$/).required() });
module.exports = { parse, objectId, revisionBody, emptyBody, eventList, checkout, list, settings, identity };
