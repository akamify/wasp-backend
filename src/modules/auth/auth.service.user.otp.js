const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { generateOtpCode, buildOtpEmailHtml, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");
const { signToken } = require("@modules/auth/auth.tokens");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");
const { verifyLoginChallengeToken, verifyRegisterChallengeToken } = require("@modules/auth/auth.tokens");

async function verifyLoginOtp({ challengeToken, otp }) {
  let payload = null;
  try {
    payload = verifyLoginChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired login challenge");
  }

  const user = await repo.findUserForVerifyLoginOtp(payload.sub);
  if (!user) throw new HttpError(404, "User not found");
  if (user.accountBlocked || String(user.status || "active") === "banned") throw new HttpError(403, "Account blocked");
  if (!user.loginOtpCodeHash || !user.loginOtpCodeExpiresAt || user.loginOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Please login again.");
  }
  if (sha256Hex(String(otp || "")) !== user.loginOtpCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.loginOtpCodeHash = undefined;
  user.loginOtpCodeExpiresAt = undefined;
  await user.save();

  const workspace = await ensureDefaultWorkspace(user);
  const token = signToken({ user, workspaceId: workspace._id });

  return {
    body: {
      success: true,
      token,
      workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        twoFactorEnabled: !!user.twoFactorEnabled,
      },
    },
  };
}

async function resendLoginOtp({ challengeToken }) {
  let payload = null;
  try {
    payload = verifyLoginChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired login challenge");
  }

  const user = await repo.findUserForResendLoginOtp(payload.sub);
  if (!user) throw new HttpError(404, "User not found");
  if (!user.twoFactorEnabled) throw new HttpError(400, "2FA is not enabled for this account");

  const otp = generateOtpCode();
  user.loginOtpCodeHash = sha256Hex(otp);
  user.loginOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Your login OTP code",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Two-factor verification",
      subtitle: "Enter this one-time code to complete your sign-in.",
    }),
    textContent: `Your login OTP code is ${otp}. It expires in 10 minutes.`,
  });

  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  return {
    body: {
      success: true,
      message: "OTP resent to your registered email.",
      ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
    },
  };
}

async function verifyRegisterOtp({ challengeToken, otp }) {
  let payload = null;
  try {
    payload = verifyRegisterChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired registration challenge");
  }

  const user = await repo.findUserForVerifyRegisterOtp(payload.sub);
  if (!user) throw new HttpError(404, "User not found");
  if (user.accountBlocked || String(user.status || "active") === "banned") throw new HttpError(403, "Account blocked");
  if (!user.registerOtpCodeHash || !user.registerOtpCodeExpiresAt || user.registerOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (sha256Hex(String(otp || "")) !== user.registerOtpCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.registerOtpCodeHash = undefined;
  user.registerOtpCodeExpiresAt = undefined;
  await user.save();

  const workspace = await ensureDefaultWorkspace(user);
  const token = signToken({ user, workspaceId: workspace._id });

  return {
    body: {
      success: true,
      token,
      workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        twoFactorEnabled: !!user.twoFactorEnabled,
      },
    },
  };
}

async function resendRegisterOtp({ challengeToken }) {
  let payload = null;
  try {
    payload = verifyRegisterChallengeToken(challengeToken);
  } catch {
    throw new HttpError(401, "Invalid or expired registration challenge");
  }

  const user = await repo.findUserForResendRegisterOtp(payload.sub);
  if (!user) throw new HttpError(404, "User not found");

  const otp = generateOtpCode();
  user.registerOtpCodeHash = sha256Hex(otp);
  user.registerOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Verify your account",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Verify your email",
      subtitle: "Enter this OTP to finish creating your account.",
    }),
    textContent: `Your verification OTP is ${otp}. It expires in 10 minutes.`,
  });

  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  return {
    body: {
      success: true,
      message: "OTP resent to your registered email.",
      ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
    },
  };
}

module.exports = {
  verifyLoginOtp,
  resendLoginOtp,
  verifyRegisterOtp,
  resendRegisterOtp,
};


