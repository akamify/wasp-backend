const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { validate } = require("@core/middleware/validate");
const rateLimiters = require("@core/middleware/rateLimiters");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const controller = require("@modules/auth/auth.controller");
const v = require("@modules/auth/auth.validation");

const router = express.Router();

router.post("/register", rateLimiters.login, validate(v.registerSchema), asyncHandler(controller.register));
router.post("/login", rateLimiters.login, validate(v.loginSchema), asyncHandler(controller.login));
router.post("/login/verify-otp", rateLimiters.otp, validate(v.verifyOtpSchema), asyncHandler(controller.verifyLoginOtp));
router.post("/login/resend-otp", rateLimiters.otp, validate(v.resendOtpSchema), asyncHandler(controller.resendLoginOtp));
router.post("/register/verify-otp", rateLimiters.otp, validate(v.verifyOtpSchema), asyncHandler(controller.verifyRegisterOtp));
router.post("/register/resend-otp", rateLimiters.otp, validate(v.resendOtpSchema), asyncHandler(controller.resendRegisterOtp));
router.post("/forgot-password", rateLimiters.otp, validate(v.forgotPasswordSchema), asyncHandler(controller.forgotPassword));
router.post("/reset-password", rateLimiters.otp, validate(v.resetPasswordSchema), asyncHandler(controller.resetPassword));

// Admin password reset (sends email to ADMIN_EMAIL)
router.post(
  "/admin/forgot-password",
  rateLimiters.otp,
  validate(v.forgotPasswordSchema),
  asyncHandler(controller.adminForgotPassword)
);
router.post(
  "/admin/reset-password",
  rateLimiters.otp,
  validate(v.resetPasswordSchema),
  asyncHandler(controller.adminResetPassword)
);

router.get("/me", auth, asyncHandler(controller.me));
router.get("/api-key", auth, requireWorkspace, asyncHandler(controller.apiKeyStatus));
router.post(
  "/api-key/request-otp",
  rateLimiters.auth,
  auth,
  requireWorkspace,
  validate(v.apiKeyRequestOtpSchema),
  asyncHandler(controller.requestApiKeyOtp)
);
router.post(
  "/api-key/verify-otp",
  rateLimiters.auth,
  auth,
  requireWorkspace,
  validate(v.apiKeyVerifyOtpSchema),
  asyncHandler(controller.verifyApiKeyOtp)
);
router.put("/profile", auth, validate(v.updateProfileSchema), asyncHandler(controller.updateProfile));
router.post(
  "/profile/request-otp",
  rateLimiters.otp,
  auth,
  validate(v.requestProfileOtpSchema),
  asyncHandler(controller.requestProfileOtp)
);
router.post(
  "/profile/verify-otp",
  rateLimiters.otp,
  auth,
  validate(v.verifyProfileOtpSchema),
  asyncHandler(controller.verifyProfileOtp)
);
router.post("/change-password", auth, validate(v.changePasswordSchema), asyncHandler(controller.changePassword));
router.post("/2fa/request-enable", auth, asyncHandler(controller.requestEnable2fa));
router.post("/2fa/verify-enable", auth, validate(v.verifyEnable2faSchema), asyncHandler(controller.verifyEnable2fa));
router.post("/2fa/disable", auth, asyncHandler(controller.disable2fa));
router.post("/logout", auth, asyncHandler(controller.logout));

module.exports = router;

