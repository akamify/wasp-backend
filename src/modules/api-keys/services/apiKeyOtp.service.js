const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/api-keys/repositories/apiKey.repository");
const { generateOtpCode, buildOtpEmailHtml, isProdEnv, shouldReturnAuthDebugTokens } = require("@modules/auth/auth.utils");

const OTP_MAX_ATTEMPTS = 5;

async function sendSecurityOtp({ userId, purpose, keyId, title, subtitle }) {
  const otp = generateOtpCode();
  const otpHash = sha256Hex(otp);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const user = await repo.setApiKeyOtp({ userId, otpHash, expiresAt, purpose, keyId });
  if (!user) throw new HttpError(404, "User not found");
  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject: "Security OTP verification",
    htmlContent: buildOtpEmailHtml({ code: otp, title, subtitle }),
    textContent: `Your OTP code is ${otp}. It expires in 10 minutes.`,
  });
  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) throw new HttpError(500, "Email service is not configured");
  return {
    success: true,
    message: "OTP sent",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  };
}

async function verifySecurityOtp({ userId, otp, purpose, keyId }) {
  const code = String(otp || "").trim();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "Invalid OTP");
  const user = await repo.findUserForApiKeyOtp(userId);
  if (!user) throw new HttpError(404, "User not found");
  if (!user.apiKeyOtpCodeHash || !user.apiKeyOtpCodeExpiresAt || user.apiKeyOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (String(user.apiKeyOtpPurpose || "") !== String(purpose || "")) throw new HttpError(400, "OTP purpose mismatch");
  if (keyId && String(user.apiKeyOtpKeyId || "") !== String(keyId || "")) throw new HttpError(400, "OTP key mismatch");
  const attempts = Number(user.apiKeyOtpAttempts || 0);
  if (attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Request a new OTP.");
  if (sha256Hex(code) !== user.apiKeyOtpCodeHash) {
    user.apiKeyOtpAttempts = attempts + 1;
    await user.save();
    throw new HttpError(401, "Invalid OTP");
  }
  user.apiKeyOtpCodeHash = undefined;
  user.apiKeyOtpCodeExpiresAt = undefined;
  user.apiKeyOtpPurpose = undefined;
  user.apiKeyOtpAttempts = 0;
  user.apiKeyOtpKeyId = undefined;
  await user.save();
  return { success: true };
}

module.exports = { sendSecurityOtp, verifySecurityOtp };
