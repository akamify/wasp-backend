const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const { authOrApiKey } = require("../middleware/authOrApiKey");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { triggerEvent } = require("../controllers/automationController");
const rateLimiters = require("../middleware/rateLimiters");

const router = express.Router();

router.post(
  "/trigger-event",
  authOrApiKey,
  requireWorkspace,
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
