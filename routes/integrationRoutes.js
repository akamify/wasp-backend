const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const rateLimiters = require("../middleware/rateLimiters");
const { validate } = require("../middleware/validate");
const { apiKeyAuth } = require("../middleware/apiKeyAuth");
const { sendApiCampaignByName } = require("../controllers/integrationCampaignController");

const router = express.Router();

router.post(
  "/campaigns/send",
  rateLimiters.general,
  apiKeyAuth,
  validate(
    Joi.object({
      campaignName: Joi.string().trim().min(2).max(140).required(),
      recipients: Joi.array()
        .items(
          Joi.alternatives().try(
            Joi.string().min(8).max(30),
            Joi.object({
              to: Joi.string().min(8).max(30).required(),
              variables: Joi.array().items(Joi.string().allow("")).max(20).optional(),
              headerVariables: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              otpCode: Joi.string().allow("").max(20).optional(),
              buttonValues: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              buttonTtlMinutes: Joi.array().items(Joi.number().min(0).max(43200)).max(10).optional(),
              flowTokens: Joi.array().items(Joi.string().allow("")).max(10).optional(),
              flowActionData: Joi.array().max(10).optional(),
            })
          )
        )
        .min(1)
        .max(50000)
        .required(),
      scheduledAt: Joi.date().iso().optional(),
    })
  ),
  asyncHandler(sendApiCampaignByName)
);

module.exports = router;

