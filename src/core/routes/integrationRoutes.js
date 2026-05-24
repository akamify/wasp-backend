const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const rateLimiters = require("@core/middleware/rateLimiters");
const { validate } = require("@core/middleware/validate");
const { apiKeyAuth } = require("@core/middleware/apiKeyAuth");
const { requireApiPermission } = require("@modules/api-keys/middleware/requireApiPermission");
const { sendApiCampaignByName } = require("@modules/integrations/controllers/integrationCampaign.controller");

const router = express.Router();

router.post(
  "/campaigns/send",
  rateLimiters.general,
  apiKeyAuth,
  requireApiPermission("campaignSend"),
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
        .max(5000)
        .required(),
      scheduledAt: Joi.date().iso().optional(),
    })
  ),
  asyncHandler(sendApiCampaignByName)
);

module.exports = router;


