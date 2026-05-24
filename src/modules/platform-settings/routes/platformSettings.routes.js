const express = require("express");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const controller = require("@modules/platform-settings/controllers/platformSettings.controller");
const {
  updateSettingSchema,
  bulkUpdateSettingsSchema,
  emailTestSchema,
} = require("@modules/platform-settings/validations/platformSettings.validation");

const router = express.Router();

router.get("/", asyncHandler(controller.listSettings));
router.get("/:category", asyncHandler(controller.listSettingsByCategory));
router.put("/:key", validate(updateSettingSchema), asyncHandler(controller.updateSetting));
router.post("/bulk", validate(bulkUpdateSettingsSchema), asyncHandler(controller.bulkUpdateSettings));
router.post("/:category/test", (req, res, next) => {
  const category = String(req.params.category || "").trim();
  if (category === "email") {
    return validate(emailTestSchema)(req, res, next);
  }
  return next();
}, asyncHandler(controller.testCategory));

module.exports = router;
