const Joi = require("joi");
const { validate } = require("@core/middleware/validate");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { HttpError } = require("@shared/utils/httpError");
const { Employee } = require("@infra/database/Employee");
const employeeAuthService = require("@modules/crm/services/employeeAuth.service");

const loginSchema = Joi.object({
  workspaceId: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(1).max(200).required(),
});

async function login(req, res) {
  const payload = await loginSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  const result = await employeeAuthService.loginEmployee(payload);
  res.json({ success: true, token: result.token, employee: result.employee });
}

const forgotSchema = Joi.object({
  workspaceId: Joi.string().required(),
  email: Joi.string().email().required(),
});

async function forgotPassword(req, res) {
  const payload = await forgotSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  await employeeAuthService.forgotEmployeePassword(payload);
  res.json({ success: true, message: "If the account exists, a reset link has been sent to the email." });
}

const resetSchema = Joi.object({
  token: Joi.string().min(10).required(),
  newPassword: Joi.string().min(6).max(200).required(),
});

async function resetPassword(req, res) {
  const payload = await resetSchema.validateAsync(req.body, { abortEarly: false, stripUnknown: true });
  await employeeAuthService.resetEmployeePassword(payload);
  res.json({ success: true });
}

module.exports = {
  login: asyncHandler(login),
  forgotPassword: asyncHandler(forgotPassword),
  resetPassword: asyncHandler(resetPassword),
  schemas: { loginSchema, forgotSchema, resetSchema },
};

