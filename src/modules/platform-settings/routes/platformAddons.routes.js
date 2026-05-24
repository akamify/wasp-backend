const express = require("express");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const controller = require("@modules/platform-settings/controllers/platformAddons.controller");
const {
  updateAddonSchema,
  bulkUpdateAddonsSchema,
} = require("@modules/platform-settings/validations/platformAddons.validation");

const router = express.Router();

router.get("/", asyncHandler(controller.listAddons));
router.get("/:category", asyncHandler(controller.listAddonsByCategory));
router.put("/:key", validate(updateAddonSchema), asyncHandler(controller.updateAddon));
router.post("/bulk", validate(bulkUpdateAddonsSchema), asyncHandler(controller.bulkUpdateAddons));

module.exports = router;
