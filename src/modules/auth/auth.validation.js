const Joi = require("joi");

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  name: Joi.string().max(120).allow("", null),
  phone: Joi.string().max(40).allow("", null),
});

const loginSchema = Joi.object({
  email: Joi.alternatives().try(Joi.string().email(), Joi.string().valid("admin")).required(),
  password: Joi.string().required(),
});

const verifyOtpSchema = Joi.object({
  challengeToken: Joi.string().required(),
  otp: Joi.string().pattern(/^\d{6}$/).required(),
});

const resendOtpSchema = Joi.object({
  challengeToken: Joi.string().required(),
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
});

const resetPasswordSchema = Joi.object({
  token: Joi.string().required(),
  password: Joi.string().min(8).required(),
});

const apiKeyRequestOtpSchema = Joi.object({
  purpose: Joi.string().valid("rotate", "reveal").required(),
});

const apiKeyVerifyOtpSchema = Joi.object({
  purpose: Joi.string().valid("rotate", "reveal").required(),
  otp: Joi.string().pattern(/^\d{6}$/).required(),
});

const updateProfileSchema = Joi.object({
  name: Joi.string().max(120).allow("", null).optional(),
  phone: Joi.string().max(40).allow("", null).optional(),
});

const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().required(),
  newPassword: Joi.string().min(8).required(),
});

const verifyEnable2faSchema = Joi.object({
  otp: Joi.string().pattern(/^\d{6}$/).required(),
});

module.exports = {
  registerSchema,
  loginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  apiKeyRequestOtpSchema,
  apiKeyVerifyOtpSchema,
  updateProfileSchema,
  changePasswordSchema,
  verifyEnable2faSchema,
};

