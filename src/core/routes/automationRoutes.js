const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { authOrApiKey } = require("@core/middleware/authOrApiKey");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireBillingFeature } = require("@core/middleware/requireBillingFeature");
const { triggerEvent } = require("@modules/automation/controllers/automation.controller");
const rateLimiters = require("@core/middleware/rateLimiters");

const router = express.Router();
const requireAutomationAccess = requireBillingFeature("automationPageAccess", {
  message: "Your current plan does not include automation access.",
});

router.post(
  "/trigger-event",
  authOrApiKey,
  requireWorkspace,
  requireAutomationAccess,
  rateLimiters.automationTrigger,
  validate(
    Joi.object({
      eventName: Joi.string().min(1).max(200).required(),
      workspaceId: Joi.string().optional(),
      phone: Joi.string().min(8).max(20).required(),
      templateId: Joi.string().required(),
      languageCode: Joi.string().min(2).max(20).optional(),
      variables: Joi.array().items(Joi.string().allow("")).optional(),
      headerVariables: Joi.array().items(Joi.string().allow("")).optional(),
      otpCode: Joi.string().trim().min(1).optional(),
      buttonValues: Joi.array().items(Joi.string().allow("")).optional(),
    })
  ),
  asyncHandler(triggerEvent)
);

module.exports = router;

