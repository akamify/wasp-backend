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
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");

const router = express.Router();

router.get("/connection", auth, requireWorkspace, requireWorkspacePermission("whatsapp.view"), asyncHandler(getWhatsAppConnection));
router.post(
  "/embedded-signup/exchange",
  auth,
  requireWorkspace,
  requireWorkspacePermission("whatsapp.connect"),
  validate(
    Joi.object({
      code: Joi.string().allow("", null).optional(),
      waba_id: Joi.string().allow("", null).optional(),
      phone_number_id: Joi.string().allow("", null).optional(),
    })
  ),
  asyncHandler(exchangeEmbeddedSignupCode)
);
router.post("/disconnect", auth, requireWorkspace, requireWorkspacePermission("whatsapp.disconnect"), asyncHandler(disconnectWhatsAppConnection));
router.post("/connection/refresh-metadata", auth, requireWorkspace, requireWorkspacePermission("whatsapp.view"), asyncHandler(refreshConnectionMetadata));
router.post("/templates/refresh", auth, requireWorkspace, requireWorkspacePermission("templates.view"), asyncHandler(syncMetaTemplates));

module.exports = router;
