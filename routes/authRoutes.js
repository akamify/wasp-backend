const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const rateLimiters = require("../middleware/rateLimiters");
const { auth } = require("../middleware/auth");
const { requireWorkspace } = require("../middleware/requireWorkspace");
const {
  register,
  login,
  verifyLoginOtp,
  resendLoginOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
  me,
  apiKeyStatus,
  requestApiKeyOtp,
  verifyApiKeyOtp,
  updateProfile,
  changePassword,
  requestEnable2fa,
  verifyEnable2fa,
  disable2fa,
  forgotPassword,
  resetPassword,
} = require("../controllers/authController");

const router = express.Router();

router.post(
  "/register",
  rateLimiters.login,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
      name: Joi.string().max(120).allow("", null),
      phone: Joi.string().max(40).allow("", null),
    })
  ),
  asyncHandler(register)
);

router.post(
  "/login",
  rateLimiters.login,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().required(),
    })
  ),
  asyncHandler(login)
);

router.post(
  "/login/verify-otp",
  rateLimiters.otp,
  validate(
    Joi.object({
      challengeToken: Joi.string().required(),
      otp: Joi.string().pattern(/^\d{6}$/).required(),
    })
  ),
  asyncHandler(verifyLoginOtp)
);

router.post(
  "/login/resend-otp",
  rateLimiters.otp,
  validate(
    Joi.object({
      challengeToken: Joi.string().required(),
    })
  ),
  asyncHandler(resendLoginOtp)
);

router.post(
  "/register/verify-otp",
  rateLimiters.otp,
  validate(
    Joi.object({
      challengeToken: Joi.string().required(),
      otp: Joi.string().pattern(/^\d{6}$/).required(),
    })
  ),
  asyncHandler(verifyRegisterOtp)
);

router.post(
  "/register/resend-otp",
  rateLimiters.otp,
  validate(
    Joi.object({
      challengeToken: Joi.string().required(),
    })
  ),
  asyncHandler(resendRegisterOtp)
);

router.post(
  "/forgot-password",
  rateLimiters.otp,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
    })
  ),
  asyncHandler(forgotPassword)
);

router.post(
  "/reset-password",
  rateLimiters.otp,
  validate(
    Joi.object({
      token: Joi.string().required(),
      password: Joi.string().min(8).required(),
    })
  ),
  asyncHandler(resetPassword)
);

router.get("/me", auth, asyncHandler(me));
router.get("/api-key", auth, requireWorkspace, asyncHandler(apiKeyStatus));
router.post(
  "/api-key/request-otp",
  rateLimiters.auth,
  auth,
  requireWorkspace,
  validate(Joi.object({ purpose: Joi.string().valid("rotate", "reveal").required() })),
  asyncHandler(requestApiKeyOtp)
);
router.post(
  "/api-key/verify-otp",
  rateLimiters.auth,
  auth,
  requireWorkspace,
  validate(
    Joi.object({
      purpose: Joi.string().valid("rotate", "reveal").required(),
      otp: Joi.string().pattern(/^\d{6}$/).required(),
    })
  ),
  asyncHandler(verifyApiKeyOtp)
);
router.put(
  "/profile",
  auth,
  validate(
    Joi.object({
      name: Joi.string().max(120).allow("", null).optional(),
      phone: Joi.string().max(40).allow("", null).optional(),
    })
  ),
  asyncHandler(updateProfile)
);

router.post(
  "/change-password",
  auth,
  validate(
    Joi.object({
      currentPassword: Joi.string().required(),
      newPassword: Joi.string().min(8).required(),
    })
  ),
  asyncHandler(changePassword)
);

router.post("/2fa/request-enable", auth, asyncHandler(requestEnable2fa));
router.post(
  "/2fa/verify-enable",
  auth,
  validate(
    Joi.object({
      otp: Joi.string().pattern(/^\d{6}$/).required(),
    })
  ),
  asyncHandler(verifyEnable2fa)
);
router.post("/2fa/disable", auth, asyncHandler(disable2fa));

module.exports = router;
