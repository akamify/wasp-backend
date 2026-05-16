const bcrypt = require("bcryptjs");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { generateOtpCode, buildOtpEmailHtml, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");
const { signToken, signLoginChallengeToken } = require("@modules/auth/auth.tokens");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");

async function loginUser({ email, password }) {
  const user = await repo.findUserForLoginByEmail(String(email).toLowerCase());
  if (!user) throw new HttpError(401, "Invalid credentials");
  if (String(user.status || "active") === "banned" || user.accountBlocked) throw new HttpError(403, "Account blocked");

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new HttpError(401, "Invalid credentials");

  if (user.twoFactorEnabled) {
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
        requires2fa: true,
        challengeToken: signLoginChallengeToken(user._id),
        ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
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

module.exports = {
  loginUser,
};


