const Joi = require("joi");
const { parse, objectId, revisionBody } = require("./catalog.validators");
const environment = Joi.string().valid("test", "live").required();
const manual = Joi.object({ environment,
  keyId: Joi.string().pattern(/^rzp_(test|live)_(?!oauth_)[a-zA-Z0-9]{8,64}$/).required(),
  keySecret: Joi.string().pattern(/^[\x21-\x7e]{8,256}$/).required(),
}).custom((v, h) => v.keyId.startsWith(`rzp_${v.environment}_`) ? v : h.error("any.invalid"));
const oauthStart = Joi.object({ environment });
const callback = Joi.object({ state: Joi.string().pattern(/^[a-f0-9]{64}$/).required(),
  code: Joi.string().min(1).max(8192), error: Joi.string().min(1).max(256),
  error_description: Joi.string().max(2048).allow("") }).xor("code", "error");
const revocation = Joi.object({ event: Joi.string().valid("account.app.authorization_revoked").required(),
  account_id: Joi.string().pattern(/^acc_[a-zA-Z0-9]{1,64}$/).required(),
  created_at: Joi.number().integer().min(1).required(), contains: Joi.array().max(20) }).unknown(true);
module.exports = { parse, objectId, revisionBody, manual, oauthStart, callback, environment, revocation };
