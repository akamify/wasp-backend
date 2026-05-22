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

const planUpsertSchema = Joi.object({
  slug: Joi.string().min(2).max(100).optional(),
  name: Joi.string().min(2).max(120).required(),
  description: Joi.string().allow("").optional(),
  originalPriceRupees: Joi.number().min(0).allow(null).required(),
  discountedPriceRupees: Joi.number().min(0).allow(null).required(),
  gstPercent: Joi.number().min(0).max(100).required(),
  taxMode: Joi.string().valid("exclusive").optional(),
  buttonText: Joi.string().allow("").optional(),
  badgeText: Joi.string().allow("").optional(),
  featureRows: Joi.array().items(featureRowSchema).required(),
  recommended: Joi.boolean().optional(),
  sortOrder: Joi.number().integer().min(1).max(5).optional(),
  reviewNote: Joi.string().allow("").optional(),
}).unknown(false);

const settingsSchema = Joi.object({
  defaultGstPercent: Joi.number().min(0).max(100).required(),
  taxMode: Joi.string().valid("exclusive").required(),
}).unknown(false);

router.get("/plans", asyncHandler(c.listPlans));
router.get("/plans/:id", asyncHandler(c.getPlan));
router.post("/plans", validate(planUpsertSchema), asyncHandler(c.createPlan));
router.put("/plans/:id", validate(planUpsertSchema), asyncHandler(c.updatePlan));
router.post("/plans/:id/review", validate(Joi.object({ reviewNote: Joi.string().allow("").optional() }).unknown(false)), asyncHandler(c.reviewPlan));
router.post("/plans/:id/publish", validate(Joi.object({ reviewNote: Joi.string().allow("").optional() }).unknown(false)), asyncHandler(c.publishPlan));
router.patch("/plans/:id/disable", asyncHandler(c.disablePlan));

router.get("/settings", asyncHandler(c.getBillingSettings));
router.put("/settings", validate(settingsSchema), asyncHandler(c.updateBillingSettings));
router.post(
  "/plans/price-preview",
  validate(
    Joi.object({
      originalPriceRupees: Joi.number().min(0).allow(null).required(),
      discountedPriceRupees: Joi.number().min(0).allow(null).required(),
      gstPercent: Joi.number().min(0).max(100).required(),
      taxMode: Joi.string().valid("exclusive").optional(),
    }).unknown(false)
  ),
  asyncHandler(c.pricePreview)
);

module.exports = router;
