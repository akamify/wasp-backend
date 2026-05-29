const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const {
  exchangeEmbeddedSignupCode,
  getWhatsAppConnection,
  disconnectWhatsAppConnection,
} = require("@modules/meta/controllers/metaEmbeddedSignup.controller");

const router = express.Router();

router.get("/connection", auth, requireWorkspace, asyncHandler(getWhatsAppConnection));
router.post(
  "/embedded-signup/exchange",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      code: Joi.string().required(),
      waba_id: Joi.string().required(),
      phone_number_id: Joi.string().required(),
    })
  ),
  asyncHandler(exchangeEmbeddedSignupCode)
);
router.post("/disconnect", auth, requireWorkspace, asyncHandler(disconnectWhatsAppConnection));

module.exports = router;

