const express = require("express");
const Joi = require("joi");
const { apiKeyAuth } = require("@core/middleware/apiKeyAuth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { serverCollect } = require("@modules/conversions/controllers/conversion.controller");

const router = express.Router();

router.post(
  "/events",
  apiKeyAuth,
  requireWorkspace,
  validate(
    Joi.object({
      event: Joi.string().trim().required(),
      eventName: Joi.string().trim().optional(),
      trackingToken: Joi.string().trim().optional(),
      messageId: Joi.string().trim().optional(),
      phone: Joi.string().trim().optional(),
      amount: Joi.number().optional(),
      value: Joi.number().optional(),
      currency: Joi.string().trim().max(8).optional(),
      orderId: Joi.string().trim().max(120).allow("").optional(),
      metadata: Joi.object().optional(),
    })
      .or("trackingToken", "messageId", "phone")
      .required()
  ),
  asyncHandler(serverCollect)
);

module.exports = router;
