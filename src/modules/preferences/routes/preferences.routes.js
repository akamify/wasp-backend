const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const preferencesController = require("@modules/preferences/controllers/preferences.controller");

const router = express.Router();

const updateAutomationBuilderSchema = Joi.object({
  leftSidebarCollapsed: Joi.boolean().optional(),
  rightSettingsOpen: Joi.boolean().optional(),
  leftSidebarWidth: Joi.number().integer().min(64).max(360).optional(),
  rightSettingsWidth: Joi.number().integer().min(300).max(520).optional(),
  lastActivePanel: Joi.string()
    .valid("flow_settings", "node_settings")
    .optional(),
  lastActiveLeftTab: Joi.string().valid("messages", "actions").optional(),
}).min(1);

router.get(
  "/automation-builder",
  auth,
  requireWorkspace,
  asyncHandler(preferencesController.getAutomationBuilder)
);

router.patch(
  "/automation-builder",
  auth,
  requireWorkspace,
  validate(updateAutomationBuilderSchema),
  asyncHandler(preferencesController.updateAutomationBuilder)
);

module.exports = router;
