const bcrypt = require("bcryptjs");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { generateOtpCode, buildOtpEmailHtml, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");
const { signRegisterChallengeToken } = require("@modules/auth/auth.tokens");

async function register({ email, password, name, phone }) {
  const existing = await repo.findUserIdByEmail(String(email).toLowerCase());
  if (existing) throw new HttpError(409, "Email already registered");

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await repo.createUser({ email, passwordHash, name, phone });
  const workspace = await repo.createWorkspaceForOwner({
    ownerId: user._id,
    name: name ? `${String(name).trim()}'s workspace` : "My workspace",
  });

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
    statusCode: 201,
    body: {
      success: true,
      requiresOtp: true,
      challengeToken: signRegisterChallengeToken(user._id),
      workspace: { id: workspace._id, name: workspace.name, plan: workspace.plan },
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        role: user.role,
        twoFactorEnabled: !!user.twoFactorEnabled,
      },
      ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
    },
  };
}

module.exports = {
  register,
};


