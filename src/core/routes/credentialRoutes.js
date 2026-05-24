const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const {
  upsertCredentials,
  getCredentials,
  deleteCredentials,
} = require("@modules/credentials/controllers/credentials.controller");

const router = express.Router();

router.get("/whatsapp", auth, requireWorkspace, asyncHandler(getCredentials));

router.put(
  "/whatsapp",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      accessToken: Joi.string().min(10).required(),
      phoneNumberId: Joi.string().min(3).required(),
      businessAccountId: Joi.string().min(3).optional(),
      wabaId: Joi.string().min(3).optional(),
      graphApiVersion: Joi.string().pattern(/^v\d+\.\d+$/).optional(),
      override: Joi.boolean().optional(),
      overrideReason: Joi.string().trim().max(400).allow("", null).optional(),
    }).or("businessAccountId", "wabaId")
  ),
  asyncHandler(upsertCredentials)
);

router.delete("/whatsapp", auth, requireWorkspace, asyncHandler(deleteCredentials));

module.exports = router;

