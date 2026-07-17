const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const c = require("@modules/billing/controllers/billing.superadmin.controller");

const router = express.Router();

const featureRowSchema = Joi.object({
  label: Joi.string().min(1).max(200).required(),
  type: Joi.string().valid("functionality", "limit", "text").required(),
  functionalityKey: Joi.string().allow("").optional(),
  limitKey: Joi.string().allow("").optional(),
  value: Joi.any().allow(null),
  included: Joi.boolean().required(),
  sortOrder: Joi.number().integer().optional(),
}).unknown(false);

const featureMapSchema = Joi.object().pattern(Joi.string().min(1).max(80), Joi.boolean()).default({});
const limitMapSchema = Joi.object().pattern(Joi.string().min(1).max(80), Joi.number().integer().min(0).allow(null)).default({});
const displayListSchema = Joi.array().items(Joi.string().min(1).max(200)).max(80).default([]);

const planUpsertSchema = Joi.object({
  slug: Joi.string().min(2).max(100).optional(),
  name: Joi.string().min(2).max(120).required(),
  description: Joi.string().allow("").optional(),
  originalPriceRupees: Joi.number().min(0).allow(null).required(),
  discountedPriceRupees: Joi.number().min(0).allow(null).required(),
  gstPercent: Joi.number().min(0).max(100).required(),
  taxMode: Joi.string().valid("exclusive", "inclusive", "none").optional(),
  billingCycle: Joi.string().valid("monthly", "quarterly", "yearly", "lifetime").optional(),
  trial: Joi.object({ enabled: Joi.boolean().required(), days: Joi.number().integer().min(0).max(365).required() }).optional(),
  status: Joi.string().valid("draft", "in_review", "published", "archived", "disabled").optional(),
  publicVisible: Joi.boolean().optional(),
  purchasable: Joi.boolean().optional(),
  buttonText: Joi.string().allow("").optional(),
  badgeText: Joi.string().allow("").optional(),
  badgeType: Joi.string().valid("none", "popular", "best_value", "recommended", "limited_offer", "enterprise", "coming_soon").optional(),
  cardColor: Joi.string().valid("blue", "green", "purple", "gold", "slate").optional(),
  icon: Joi.string().allow("").max(8).optional(),
  features: featureMapSchema.optional(),
  limits: limitMapSchema.optional(),
  displayFeatures: displayListSchema.optional(),
  unavailableFeatures: displayListSchema.optional(),
  addonServices: displayListSchema.optional(),
  featureRows: Joi.array().items(featureRowSchema).optional().default([]),
  recommended: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(1).max(5).optional(),
  reviewNote: Joi.string().allow("").optional(),
}).unknown(false);

const settingsSchema = Joi.object({
  defaultGstPercent: Joi.number().min(0).max(100).required(),
  taxMode: Joi.string().valid("exclusive", "inclusive", "none").required(),
}).unknown(false);

router.get("/plans", asyncHandler(c.listPlans));
router.get("/plans/:id", asyncHandler(c.getPlan));
router.post("/plans", validate(planUpsertSchema), asyncHandler(c.createPlan));
router.put("/plans/:id", validate(planUpsertSchema), asyncHandler(c.updatePlan));
router.post("/plans/:id/review", validate(Joi.object({ reviewNote: Joi.string().allow("").optional() }).unknown(false)), asyncHandler(c.reviewPlan));
router.post("/plans/:id/publish", validate(Joi.object({ reviewNote: Joi.string().allow("").optional() }).unknown(false)), asyncHandler(c.publishPlan));
router.patch("/plans/:id/disable", asyncHandler(c.disablePlan));
router.delete("/plans/:id", asyncHandler(c.deletePlan));

router.get("/settings", asyncHandler(c.getBillingSettings));
router.put("/settings", validate(settingsSchema), asyncHandler(c.updateBillingSettings));
router.post(
  "/plans/price-preview",
  validate(
    Joi.object({
      originalPriceRupees: Joi.number().min(0).allow(null).required(),
      discountedPriceRupees: Joi.number().min(0).allow(null).required(),
      gstPercent: Joi.number().min(0).max(100).required(),
      taxMode: Joi.string().valid("exclusive", "inclusive", "none").optional(),
      billingCycle: Joi.string().valid("monthly", "quarterly", "yearly", "lifetime").optional(),
    }).unknown(false)
  ),
  asyncHandler(c.pricePreview)
);

module.exports = router;
