const Joi = require("joi");

const platformQuerySchema = Joi.object({
  platform: Joi.string().valid("woocommerce", "shopify").optional(),
});

const createStoreSchema = Joi.object({
  platform: Joi.string().valid("woocommerce").default("woocommerce"),
  storeName: Joi.string().trim().min(2).max(120).required(),
  storeUrl: Joi.string().trim().uri({ scheme: ["https"] }).required(),
  consumerKey: Joi.string().trim().min(8).max(160).required(),
  consumerSecret: Joi.string().trim().min(8).max(200).required(),
});

const updateStoreSchema = Joi.object({
  storeName: Joi.string().trim().min(2).max(120).optional(),
  consumerKey: Joi.string().trim().min(8).max(160).optional(),
  consumerSecret: Joi.string().trim().min(8).max(200).optional(),
}).min(1);

const shopifyConnectStartSchema = Joi.object({
  storeId: Joi.string().trim().optional(),
});

module.exports = {
  createStoreSchema,
  platformQuerySchema,
  shopifyConnectStartSchema,
  updateStoreSchema,
};
