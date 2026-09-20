const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const { MAX_MONEY, parseRupees } = require("../domain/money");

const objectId = Joi.string().pattern(/^[a-fA-F0-9]{24}$/);
const graphId = Joi.string().pattern(/^\d{1,30}$/);
const revision = Joi.number().integer().min(1).max(1_000_000_000);
const httpsUrl = Joi.string().max(2048).custom((value, helpers) => {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.hash
        || (url.port && url.port !== "443") || !host.includes(".")
        || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")
        || host.includes(":") || /^[\d.]+$/.test(host)) return helpers.error("any.invalid");
    return value;
  } catch { return helpers.error("any.invalid"); }
});
const price = Joi.string().custom((value, helpers) => {
  try { return parseRupees(value) <= MAX_MONEY ? value : helpers.error("any.invalid"); }
  catch { return helpers.error("any.invalid"); }
});
const productFields = {
  name: Joi.string().trim().min(1).max(150),
  description: Joi.string().trim().min(1).max(5000),
  imageUrl: httpsUrl,
  productUrl: httpsUrl,
  brand: Joi.string().trim().max(100).allow(""),
  category: Joi.string().trim().max(100).allow(""),
  condition: Joi.string().valid("new", "refurbished", "used"),
  price,
  taxRateBps: Joi.number().integer().min(0).max(10000).allow(null),
  taxConfirmed: Joi.boolean(),
  available: Joi.boolean(),
  trackInventory: Joi.boolean(),
  stockOnHand: Joi.number().integer().min(0).max(1_000_000_000),
};
const createProduct = Joi.object({
  ...productFields,
  sku: Joi.string().trim().min(1).max(100).pattern(/^[^\x00-\x1f\x7f]+$/).required(),
  name: productFields.name.required(), description: productFields.description.required(),
  imageUrl: httpsUrl.required(), productUrl: httpsUrl.required(), price: price.required(),
  taxConfirmed: Joi.boolean().valid(true).required(),
  taxRateBps: productFields.taxRateBps.required(),
  condition: productFields.condition.required(),
  available: Joi.boolean().default(true), trackInventory: Joi.boolean().default(false),
  stockOnHand: productFields.stockOnHand.default(0),
});
const updateProduct = Joi.object({ ...productFields, revision: revision.required() }).min(2);
const catalogBind = Joi.object({ catalogId: graphId.required(), confirmDedicatedCatalog: Joi.boolean().valid(true).required() });
const commerceSettings = Joi.object({ revision: revision.required(), catalogVisible: Joi.boolean().required(), cartEnabled: Joi.boolean().required() });
const revisionBody = Joi.object({ revision: revision.required() });
const listQuery = Joi.object({
  cursor: objectId, limit: Joi.number().integer().min(1).max(100).default(30),
  archived: Joi.boolean().default(false),
});
function parse(schema, input, convert = false) {
  const { error, value } = schema.validate(input, { abortEarly: false, convert, stripUnknown: false });
  if (error) throw new HttpError(400, "Invalid Commerce request", { fields: error.details.map((entry) => entry.path.join(".")) });
  return value;
}
module.exports = { parse, objectId, createProduct, updateProduct, catalogBind, commerceSettings, revisionBody, listQuery };
