const bcrypt = require("bcryptjs");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const { generateOtpCode, buildOtpEmailHtml, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");

async function updateProfile({ userId, name, phone }) {
  const update = {};
  if (name !== undefined) update.name = name;
  if (phone !== undefined) update.phone = phone;

  const user = await repo
    .updateUserById(userId, { $set: update }, { new: true })
    .select("email name phone role createdAt twoFactorEnabled");
  if (!user) throw new HttpError(404, "User not found");

  return {
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
  };
}

async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await repo.findUserWithPasswordHash(userId);
  if (!user) throw new HttpError(404, "User not found");

  const ok = await bcrypt.compare(String(currentPassword || ""), user.passwordHash);
  if (!ok) throw new HttpError(401, "Current password is incorrect");

  user.passwordHash = await bcrypt.hash(String(newPassword), 12);
  await user.save();
  return { success: true };
}

async function requestEnable2fa({ userId }) {
  const user = await repo.findUserForEnable2faRequest(userId);
  if (!user) throw new HttpError(404, "User not found");

  const otp = generateOtpCode();
  user.twoFactorCodeHash = sha256Hex(otp);
  user.twoFactorCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Enable 2FA OTP code",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Enable two-factor authentication",
      subtitle: "Use this code to enable 2FA on your account.",
    }),
    textContent: `Your code to enable 2FA is ${otp}. It expires in 10 minutes.`,
  });

  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  return {
    success: true,
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  };
}

async function verifyEnable2fa({ userId, otp }) {
  const user = await repo.findUserForEnable2faVerify(userId);
  if (!user) throw new HttpError(404, "User not found");

  if (!user.twoFactorCodeHash || !user.twoFactorCodeExpiresAt || user.twoFactorCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (sha256Hex(String(otp || "")) !== user.twoFactorCodeHash) throw new HttpError(401, "Invalid OTP code");

  user.twoFactorEnabled = true;
  user.twoFactorCodeHash = undefined;
  user.twoFactorCodeExpiresAt = undefined;
  await user.save();

  return { success: true, twoFactorEnabled: true };
}

async function disable2fa({ userId }) {
  const user = await repo
    .updateUserById(
      userId,
      {
        $set: { twoFactorEnabled: false },
        $unset: { twoFactorCodeHash: 1, twoFactorCodeExpiresAt: 1, loginOtpCodeHash: 1, loginOtpCodeExpiresAt: 1 },
      },
      { new: true }
    )
    .select("twoFactorEnabled");

  if (!user) throw new HttpError(404, "User not found");
  return { success: true, twoFactorEnabled: false };
}

module.exports = {
  updateProfile,
  changePassword,
  requestEnable2fa,
  verifyEnable2fa,
  disable2fa,
};


