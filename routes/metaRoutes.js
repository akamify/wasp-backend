const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const { validate } = require("../middleware/validate");
const { saveMetaCredentials } = require("../controllers/metaCredentialsController");
const { metaStatus } = require("../controllers/metaStatusController");

const router = express.Router();

router.get("/status", auth, requireWorkspace, asyncHandler(metaStatus));

router.post(
  "/save",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      accessToken: Joi.string().min(10).required(),
      phoneNumberId: Joi.string().min(3).required(),
      wabaId: Joi.string().min(3).required(),
      graphApiVersion: Joi.string().pattern(/^v\\d+\\.\\d+$/).optional(),
    })
  ),
  asyncHandler(saveMetaCredentials)
);

module.exports = router;
