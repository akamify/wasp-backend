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
const { refreshConnectionMetadata } = require("@modules/meta/controllers/metaConnectionMetadata.controller");
const { syncMetaTemplates } = require("@modules/templates/controllers/templates.controller");

const router = express.Router();

router.get("/connection", auth, requireWorkspace, asyncHandler(getWhatsAppConnection));
router.post(
  "/embedded-signup/exchange",
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      code: Joi.string().allow("", null).optional(),
      waba_id: Joi.string().allow("", null).optional(),
      phone_number_id: Joi.string().allow("", null).optional(),
    })
  ),
  asyncHandler(exchangeEmbeddedSignupCode)
);
router.post("/disconnect", auth, requireWorkspace, asyncHandler(disconnectWhatsAppConnection));
router.post("/connection/refresh-metadata", auth, requireWorkspace, asyncHandler(refreshConnectionMetadata));
router.post("/templates/refresh", auth, requireWorkspace, asyncHandler(syncMetaTemplates));

module.exports = router;
