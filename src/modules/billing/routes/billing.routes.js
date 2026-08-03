const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { listPlans } = require("@modules/billing/controllers/plan.controller");
const { getCurrentSubscription, getSubscriptionHistory } = require("@modules/billing/controllers/subscription.controller");
const { createCheckout, verifyPayment } = require("@modules/billing/controllers/checkout.controller");
const {
  scheduleDowngrade,
  cancelScheduledChange,
  listInvoices,
  listTimeline,
  createRenewalPaymentOrder,
  getRenewalStatus,
} = require("@modules/billing/controllers/lifecycle.controller");
const {
  enableAutoRenew,
  confirmAutoRenew,
  changePaymentMethod,
  disableAutoRenew,
  toggleAutoRenew,
  renewalSettings,
} = require("@modules/billing/controllers/autoRenew.controller");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();

const checkoutSchema = Joi.object({
  planId: Joi.string().required(),
  durationMonths: Joi.number().integer().min(1).max(24).optional(),
  mode: Joi.string().valid("autopay", "one_time").optional(),
  fallbackAllowed: Joi.boolean().optional(),
}).unknown(false);

const verifyPaymentSchema = Joi.object({
  razorpay_order_id: Joi.string().optional(),
  razorpay_subscription_id: Joi.string().optional(),
  razorpay_payment_id: Joi.string().required(),
  razorpay_signature: Joi.string().required(),
})
  .or("razorpay_order_id", "razorpay_subscription_id")
  .unknown(false);

const scheduleDowngradeSchema = Joi.object({
  planId: Joi.string().required(),
}).unknown(false);

const renewSchema = Joi.object({
  invoiceId: Joi.string().optional(),
}).unknown(false);

const toggleAutoRenewSchema = Joi.object({
  enabled: Joi.boolean().required(),
}).unknown(false);

const confirmAutoRenewSchema = Joi.object({
  razorpay_subscription_id: Joi.string().required(),
  razorpay_payment_id: Joi.string().required(),
  razorpay_signature: Joi.string().required(),
}).unknown(false);

router.get("/plans", asyncHandler(listPlans));
router.get("/current", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getCurrentSubscription));
router.get("/history", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getSubscriptionHistory));
router.get("/invoices", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(listInvoices));
router.get("/timeline", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(listTimeline));
router.get("/renewal-status", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getRenewalStatus));
router.get("/payment-due", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(getRenewalStatus));
router.get("/renewal-settings", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(renewalSettings));
router.get("/payment-method", auth, requireWorkspace, requireWorkspacePermission("billing.view"), asyncHandler(renewalSettings));
router.post("/checkout", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(checkoutSchema), asyncHandler(createCheckout));
router.post("/verify-payment", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(verifyPaymentSchema), asyncHandler(verifyPayment));
router.post("/renew", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(renewSchema), asyncHandler(createRenewalPaymentOrder));
router.post("/retry-renewal", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(renewSchema), asyncHandler(createRenewalPaymentOrder));
router.post("/auto-renew/enable", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), asyncHandler(enableAutoRenew));
router.post("/auto-renew/confirm", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(confirmAutoRenewSchema), asyncHandler(confirmAutoRenew));
router.post("/auto-renew/disable", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), asyncHandler(disableAutoRenew));
router.post("/auto-renew/toggle", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), validate(toggleAutoRenewSchema), asyncHandler(toggleAutoRenew));
router.post("/change-payment-method", auth, requireWorkspace, requireWorkspacePermission("billing.manage"), asyncHandler(changePaymentMethod));
router.post(
  "/schedule-downgrade",
  auth,
  requireWorkspace,
  requireWorkspacePermission("billing.manage"),
  validate(scheduleDowngradeSchema),
  asyncHandler(scheduleDowngrade)
);
router.delete(
  "/scheduled-change",
  auth,
  requireWorkspace,
  requireWorkspacePermission("billing.manage"),
  asyncHandler(cancelScheduledChange)
);

module.exports = router;
