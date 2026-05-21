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

async function requestProfileOtp({ userId, purpose, email, name }) {
  const p = String(purpose || "").trim();
  if (!["change_email", "change_name"].includes(p)) throw new HttpError(400, "Invalid purpose");

  const user = await repo.findUserForProfileOtp(userId);
  if (!user) throw new HttpError(404, "User not found");

  if (p === "change_email") {
    const nextEmail = String(email || "").trim().toLowerCase();
    if (!nextEmail) throw new HttpError(400, "New email is required");
    user.pendingEmail = nextEmail;
  }

  if (p === "change_name") {
    const nextName = String(name || "").trim();
    if (!nextName) throw new HttpError(400, "New name is required");
    user.pendingName = nextName;
  }

  const otp = generateOtpCode();
  user.profileOtpCodeHash = sha256Hex(otp);
  user.profileOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  user.profileOtpPurpose = p;
  await user.save();

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Profile change verification code",
    htmlContent: buildOtpEmailHtml({
      code: otp,
      title: "Profile verification",
      subtitle: "Use this OTP to confirm your profile change. It expires in 10 minutes.",
    }),
    textContent: `Your OTP to confirm profile change is ${otp}. It expires in 10 minutes.`,
  });

  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  return {
    success: true,
    message: "OTP sent",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  };
}

async function verifyProfileOtp({ userId, otp }) {
  const user = await repo.findUserForProfileOtp(userId);
  if (!user) throw new HttpError(404, "User not found");

  if (!user.profileOtpCodeHash || !user.profileOtpCodeExpiresAt || user.profileOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (sha256Hex(String(otp || "").trim()) !== user.profileOtpCodeHash) throw new HttpError(401, "Invalid OTP code");

  const purpose = String(user.profileOtpPurpose || "");
  if (purpose === "change_email" && user.pendingEmail) {
    user.email = String(user.pendingEmail).toLowerCase();
  }
  if (purpose === "change_name" && user.pendingName) {
    user.name = String(user.pendingName).trim();
  }

  user.profileOtpCodeHash = undefined;
  user.profileOtpCodeExpiresAt = undefined;
  user.profileOtpPurpose = undefined;
  user.pendingEmail = undefined;
  user.pendingPhone = undefined;
  user.pendingName = undefined;
  await user.save();

  return { success: true };
}

module.exports = {
  updateProfile,
  changePassword,
  requestEnable2fa,
  verifyEnable2fa,
  disable2fa,
  requestProfileOtp,
  verifyProfileOtp,
};


