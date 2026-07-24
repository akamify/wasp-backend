const Joi = require("joi");

const platformQuerySchema = Joi.object({
  platform: Joi.string().valid("woocommerce", "shopify", "custom").optional(),
});

const createStoreSchema = Joi.alternatives().try(
  Joi.object({
  platform: Joi.string().valid("woocommerce").default("woocommerce"),
  storeName: Joi.string().trim().min(2).max(120).required(),
  storeUrl: Joi.string().trim().uri({ scheme: ["https"] }).required(),
  consumerKey: Joi.string().trim().min(8).max(160).required(),
  consumerSecret: Joi.string().trim().min(8).max(200).required(),
  }),
  Joi.object({
    platform: Joi.string().valid("custom").required(),
    storeName: Joi.string().trim().min(2).max(120).required(),
    storeUrl: Joi.string().trim().uri({ scheme: ["https"] }).required(),
  })
);

const updateStoreSchema = Joi.object({
  storeName: Joi.string().trim().min(2).max(120).optional(),
  consumerKey: Joi.string().trim().min(8).max(160).optional(),
  consumerSecret: Joi.string().trim().min(8).max(200).optional(),
}).min(1);

const shopifyConnectStartSchema = Joi.object({
  storeId: Joi.string().trim().optional(),
  shopDomain: Joi.string().trim().max(255).optional().allow(""),
});

const otpSchema = Joi.object({
  otp: Joi.string().pattern(/^\d{6}$/).required(),
});

const customTestEventSchema = Joi.object({
  topic: Joi.string().trim().max(80).optional(),
  payload: Joi.object().unknown(true).optional(),
});

module.exports = {
  createStoreSchema,
  customTestEventSchema,
  otpSchema,
  platformQuerySchema,
  shopifyConnectStartSchema,
  updateStoreSchema,
};
