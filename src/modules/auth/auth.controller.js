const adminService = require("@modules/auth/auth.service.admin");
const apiKeyService = require("@modules/auth/auth.service.apiKey");
const profileService = require("@modules/auth/auth.service.profile");
const passwordService = require("@modules/auth/auth.service.password");
const userRegisterService = require("@modules/auth/auth.service.user.register");
const userLoginService = require("@modules/auth/auth.service.user.login");
const userOtpService = require("@modules/auth/auth.service.user.otp");
const userMeService = require("@modules/auth/auth.service.user.me");
const { writeAuditLog } = require("@shared/services/auditLog.service");

function applyHeaders(res, headers) {
  if (!headers) return;
  Object.entries(headers).forEach(([k, v]) => res.set(k, v));
}

async function register(req, res) {
  const result = await userRegisterService.register(req.body);
  res.status(result.statusCode || 200).json(result.body);
}

async function login(req, res) {
  try {
    const out = (await userLoginService.loginUser({ email: req.body?.email, password: req.body?.password })).body;
    if (!out?.requires2fa && out?.user?.id) {
      await writeAuditLog(req, {
        action: "auth.login.success",
        actorId: out.user.id,
        targetId: out.user.id,
        resourceType: "auth",
        resourceId: String(out.user.id),
        metadata: { role: out?.user?.role || "", status: "success", reason: "password_verified" },
      });
    }
    return res.json(out);
  } catch (error) {
    await writeAuditLog(req, {
      action: "auth.login.failed",
      resourceType: "auth",
      metadata: {
        status: "failed",
        reason: String(error?.message || "login_failed"),
        email: String(req.body?.email || "").trim().toLowerCase(),
      },
    });
    throw error;
  }
}

async function verifyLoginOtp(req, res) {
  const out = (await userOtpService.verifyLoginOtp(req.body)).body;
  if (out?.user?.id) {
    await writeAuditLog(req, {
      action: "auth.login.success",
      actorId: out.user.id,
      targetId: out.user.id,
      resourceType: "auth",
      resourceId: String(out.user.id),
      metadata: { role: out?.user?.role || "", via: "otp", status: "success", reason: "otp_verified" },
    });
  }
  res.json(out);
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
  res.json(await userMeService.me({ authUser: req.user, selectedWorkspaceId: req.headers["x-workspace-id"] || null }));
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

async function logout(req, res) {
  await writeAuditLog(req, {
    action: "auth.logout",
    actorId: req.user?.id,
    targetId: req.user?.id,
    resourceType: "auth",
    resourceId: String(req.user?.id || ""),
    metadata: { status: "success", reason: "user_logout" },
  });
  res.json({ success: true });
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

async function requestProfileOtp(req, res) {
  const out = await profileService.requestProfileOtp({
    userId: req.user.id,
    purpose: req.body?.purpose,
    email: req.body?.email,
    name: req.body?.name,
  });
  if (out?.success) {
    await writeAuditLog(req, {
      action: "profile.otp.sent",
      actorId: req.user.id,
      targetId: req.user.id,
      resourceType: "profile",
      metadata: { purpose: String(req.body?.purpose || "") },
    });
  }
  res.json(out);
}

async function verifyProfileOtp(req, res) {
  const out = await profileService.verifyProfileOtp({ userId: req.user.id, otp: req.body?.otp });
  if (out?.success) {
    await writeAuditLog(req, {
      action: "profile.otp.verified",
      actorId: req.user.id,
      targetId: req.user.id,
      resourceType: "profile",
      metadata: {},
    });
  }
  res.json(out);
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
  requestProfileOtp,
  verifyProfileOtp,
  logout,
  forgotPassword,
  resetPassword,
  adminForgotPassword,
  adminResetPassword,
};
