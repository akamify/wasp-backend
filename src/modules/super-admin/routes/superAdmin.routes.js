const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { auth } = require("@core/middleware/auth");
const { requireSuperAdmin } = require("@core/middleware/requireRole");
const { validate } = require("@core/middleware/validate");
const c = require("@modules/super-admin/controllers/superAdmin.controller");

const router = express.Router();

router.use(auth, requireSuperAdmin);

router.get("/profile", asyncHandler(c.profile));
router.patch("/profile/name", validate(Joi.object({ name: Joi.string().min(2).max(120).required() })), asyncHandler(c.updateProfileName));
router.post(
  "/profile/change-password",
  validate(Joi.object({ currentPassword: Joi.string().required(), newPassword: Joi.string().min(8).required() })),
  asyncHandler(c.changeProfilePassword)
);
router.post(
  "/profile/request-otp",
  validate(Joi.object({ purpose: Joi.string().valid("change_email", "change_phone").required(), email: Joi.string().email().optional(), phone: Joi.string().optional() })),
  asyncHandler(c.requestProfileOtp)
);
router.post("/profile/verify-otp", validate(Joi.object({ otp: Joi.string().pattern(/^\d{6}$/).required() })), asyncHandler(c.verifyProfileOtp));
router.patch("/profile/2fa", validate(Joi.object({ enabled: Joi.boolean().required() })), asyncHandler(c.setProfile2fa));

router.get("/admins", asyncHandler(c.listAdmins));
router.get("/admins/:id", asyncHandler(c.getAdminDetail));
router.patch("/admins/:id", asyncHandler(c.updateAdmin));
router.post(
  "/admins/:id/profile-requests/:requestId/decision",
  validate(Joi.object({ decision: Joi.string().valid("approved", "rejected").required(), reviewNote: Joi.string().allow("").optional() })),
  asyncHandler(c.decideAdminProfileRequest)
);
router.post(
  "/admins/assign",
  validate(Joi.object({ email: Joi.string().email().required() })),
  asyncHandler(c.assignAdmin)
);
router.post(
  "/admins/remove",
  validate(Joi.object({ userId: Joi.string().required() })),
  asyncHandler(c.removeAdmin)
);
router.post(
  "/users/suspend",
  validate(Joi.object({ userId: Joi.string().required(), reason: Joi.string().valid("retired", "fired").optional() })),
  asyncHandler(c.suspendUser)
);
router.post(
  "/users/reset-password",
  validate(Joi.object({ userId: Joi.string().required() })),
  asyncHandler(c.resetUserPassword)
);
router.get("/security-logs", asyncHandler(c.securityLogs));

module.exports = router;
