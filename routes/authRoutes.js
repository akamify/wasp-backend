const express = require("express");
const Joi = require("joi");
const { asyncHandler } = require("../utils/asyncHandler");
const { validate } = require("../middleware/validate");
const rateLimiters = require("../middleware/rateLimiters");
const { auth } = require("../middleware/auth");
const {
  register,
  login,
  verifyLoginOtp,
  me,
  rotateApiKey,
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
  rateLimiters.auth,
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
  rateLimiters.auth,
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
  rateLimiters.auth,
  validate(
    Joi.object({
      challengeToken: Joi.string().required(),
      otp: Joi.string().pattern(/^\d{6}$/).required(),
    })
  ),
  asyncHandler(verifyLoginOtp)
);

router.post(
  "/forgot-password",
  rateLimiters.auth,
  validate(
    Joi.object({
      email: Joi.string().email().required(),
    })
  ),
  asyncHandler(forgotPassword)
);

router.post(
  "/reset-password",
  rateLimiters.auth,
  validate(
    Joi.object({
      token: Joi.string().required(),
      password: Joi.string().min(8).required(),
    })
  ),
  asyncHandler(resetPassword)
);

router.get("/me", auth, asyncHandler(me));
router.post("/api-key/rotate", auth, asyncHandler(rotateApiKey));
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

