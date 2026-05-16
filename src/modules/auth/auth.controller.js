const adminService = require("@modules/auth/auth.service.admin");
const apiKeyService = require("@modules/auth/auth.service.apiKey");
const profileService = require("@modules/auth/auth.service.profile");
const passwordService = require("@modules/auth/auth.service.password");
const userRegisterService = require("@modules/auth/auth.service.user.register");
const userLoginService = require("@modules/auth/auth.service.user.login");
const userOtpService = require("@modules/auth/auth.service.user.otp");
const userMeService = require("@modules/auth/auth.service.user.me");
const { adminEmail } = require("@core/config/env");

function applyHeaders(res, headers) {
  if (!headers) return;
  Object.entries(headers).forEach(([k, v]) => res.set(k, v));
}

async function register(req, res) {
  const result = await userRegisterService.register(req.body);
  res.status(result.statusCode || 200).json(result.body);
}

async function login(req, res) {
  const { email, password } = req.body;
  const identifier = String(email || "").trim().toLowerCase();
  const isAdminIdentifier = identifier === "admin" || (adminEmail && identifier === String(adminEmail).trim().toLowerCase());
  if (isAdminIdentifier) return res.json(await adminService.adminLogin({ email, password, req }));
  return res.json((await userLoginService.loginUser({ email, password })).body);
}

async function verifyLoginOtp(req, res) {
  res.json((await userOtpService.verifyLoginOtp(req.body)).body);
}

async function resendLoginOtp(req, res) {
  res.json((await userOtpService.resendLoginOtp(req.body)).body);
}

async function verifyRegisterOtp(req, res) {
  res.json((await userOtpService.verifyRegisterOtp(req.body)).body);
}

async function resendRegisterOtp(req, res) {
  res.json((await userOtpService.resendRegisterOtp(req.body)).body);
}

async function forgotPassword(req, res) {
  const result = await passwordService.forgotPassword({ email: req.body?.email });
  applyHeaders(res, result.headers);
  res.json(result.body);
}

async function resetPassword(req, res) {
  res.json(await passwordService.resetPassword(req.body));
}

async function adminForgotPassword(req, res) {
  const result = await adminService.adminForgotPassword({ email: req.body?.email });
  if (result?.headers) {
    applyHeaders(res, result.headers);
    return res.json(result.body);
  }
  return res.json(result);
}

async function adminResetPassword(req, res) {
  res.json(await adminService.adminResetPassword(req.body));
}

async function me(req, res) {
  res.json(await userMeService.me({ authUser: req.user }));
}

async function apiKeyStatus(req, res) {
  res.json(await apiKeyService.apiKeyStatus({ workspaceId: req.workspace.id, userId: req.user.id }));
}

async function requestApiKeyOtp(req, res) {
  res.json(
    await apiKeyService.requestApiKeyOtp({ workspaceId: req.workspace.id, userId: req.user.id, purpose: req.body?.purpose })
  );
}

async function verifyApiKeyOtp(req, res) {
  res.json(
    await apiKeyService.verifyApiKeyOtp({
      workspaceId: req.workspace.id,
      userId: req.user.id,
      purpose: req.body?.purpose,
      otp: req.body?.otp,
    })
  );
}

async function updateProfile(req, res) {
  res.json(await profileService.updateProfile({ userId: req.user.id, name: req.body?.name, phone: req.body?.phone }));
}

async function changePassword(req, res) {
  res.json(
    await profileService.changePassword({
      userId: req.user.id,
      currentPassword: req.body?.currentPassword,
      newPassword: req.body?.newPassword,
    })
  );
}

async function requestEnable2fa(req, res) {
  res.json(await profileService.requestEnable2fa({ userId: req.user.id }));
}

async function verifyEnable2fa(req, res) {
  res.json(await profileService.verifyEnable2fa({ userId: req.user.id, otp: req.body?.otp }));
}

async function disable2fa(req, res) {
  res.json(await profileService.disable2fa({ userId: req.user.id }));
}

module.exports = {
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
  adminForgotPassword,
  adminResetPassword,
};
