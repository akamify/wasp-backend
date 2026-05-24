const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { encryptString, decryptString } = require("@shared/utils/crypto");
const { sendEmail } = require("@shared/services/emailService");
const repo = require("@modules/auth/auth.repository");
const apiKeyRepo = require("@modules/api-keys/repositories/apiKey.repository");
const { generateApiKeyRaw } = require("@modules/api-keys/utils/generateApiKey");
const {
  generateApiKey,
  generateOtpCode,
  normalizeApiKeyOtpPurpose,
  buildOtpEmailHtml,
  isProdEnv,
  shouldReturnAuthDebugTokens,
} = require("@modules/auth/auth.utils");

async function ensureMetaSetupForWorkspace(workspaceId) {
  const hasValid = await repo.hasValidMetaCredentials(workspaceId);
  if (!hasValid) {
    throw new HttpError(409, "Meta/WhatsApp is not set up for this workspace yet. Connect WhatsApp first.");
  }
}

async function apiKeyStatus({ workspaceId, userId }) {
  await ensureMetaSetupForWorkspace(workspaceId);
  const user = await repo.findUserForApiKeyStatus(userId);
  if (!user) throw new HttpError(404, "User not found");
  const hasApiKey = !!user.apiKeyEnc || (Array.isArray(user.apiKeys) && user.apiKeys.some((k) => !k.revoked));
  let maskedKey = "";
  if (user.apiKeyEnc) {
    try {
      const key = decryptString(user.apiKeyEnc);
      const start = key.slice(0, 4);
      const end = key.slice(-3);
      maskedKey = `${start}***${end}`;
    } catch {
      maskedKey = "";
    }
  } else if (hasApiKey) {
    maskedKey = "wpk_***";
  }
  return { success: true, hasApiKey, maskedKey };
}

async function requestApiKeyOtp({ workspaceId, userId, purpose }) {
  const normalizedPurpose = normalizeApiKeyOtpPurpose(purpose);
  if (!normalizedPurpose) throw new HttpError(400, "Invalid purpose");

  await ensureMetaSetupForWorkspace(workspaceId);
  const user = await repo.findUserForApiKeyOtp(userId);
  if (!user) throw new HttpError(404, "User not found");

  if (normalizedPurpose === "reveal" && !user.apiKeyEnc) {
    throw new HttpError(404, "No API key exists yet. Generate one first.");
  }

  const otp = generateOtpCode();
  user.apiKeyOtpCodeHash = sha256Hex(otp);
  user.apiKeyOtpCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
  user.apiKeyOtpPurpose = normalizedPurpose;
  await user.save();

  const subject = normalizedPurpose === "rotate" ? "Your API key generation OTP" : "Your API key reveal OTP";
  const title = normalizedPurpose === "rotate" ? "API key verification" : "Reveal API key verification";
  const subtitle =
    normalizedPurpose === "rotate"
      ? "Enter this OTP code to generate a new API key. The old key will stop working."
      : "Enter this OTP code to view your API key.";

  const delivery = await sendEmail({
    toEmail: user.email,
    toName: user.name || "",
    subject,
    htmlContent: buildOtpEmailHtml({ code: otp, title, subtitle }),
    textContent: `Your OTP code is ${otp}. It expires in 10 minutes.`,
  });

  if (isProdEnv() && (delivery?.skipped || delivery?.failed)) {
    throw new HttpError(500, "Email service is not configured");
  }

  return {
    success: true,
    message: "OTP sent to your registered email.",
    ...(shouldReturnAuthDebugTokens() ? { debugOtp: otp, emailDelivery: delivery } : {}),
  };
}

async function verifyApiKeyOtp({ workspaceId, userId, purpose, otp }) {
  const normalizedPurpose = normalizeApiKeyOtpPurpose(purpose);
  const code = String(otp || "").trim();
  if (!normalizedPurpose) throw new HttpError(400, "Invalid purpose");
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "Invalid OTP code");

  await ensureMetaSetupForWorkspace(workspaceId);
  const user = await repo.findUserForVerifyApiKeyOtp(userId);
  if (!user) throw new HttpError(404, "User not found");

  if (!user.apiKeyOtpCodeHash || !user.apiKeyOtpCodeExpiresAt || user.apiKeyOtpCodeExpiresAt < new Date()) {
    throw new HttpError(400, "OTP expired. Request a new code.");
  }
  if (String(user.apiKeyOtpPurpose || "") !== normalizedPurpose) {
    throw new HttpError(400, "OTP purpose mismatch. Request a new code.");
  }
  if (sha256Hex(code) !== user.apiKeyOtpCodeHash) {
    throw new HttpError(401, "Invalid OTP code");
  }

  user.apiKeyOtpCodeHash = undefined;
  user.apiKeyOtpCodeExpiresAt = undefined;
  user.apiKeyOtpPurpose = undefined;

  if (normalizedPurpose === "rotate") {
    const apiKey = generateApiKeyRaw();
    user.apiKeyHash = sha256Hex(apiKey);
    user.apiKeyEnc = encryptString(apiKey);
    user.apiKeys = Array.isArray(user.apiKeys) ? user.apiKeys : [];
    user.apiKeys.push({
      name: "Primary key",
      keyHash: sha256Hex(apiKey),
      permissions: { campaignSend: true, chatAccess: false },
      revoked: false,
    });
    await user.save();
    return { success: true, message: "API key generated successfully.", apiKey };
  }

  if (!user.apiKeyEnc) {
    await user.save();
    throw new HttpError(404, "No API key exists yet. Generate one first.");
  }

  const apiKey = decryptString(user.apiKeyEnc);
  await user.save();
  return { success: true, message: "API key revealed successfully.", apiKey };
}

module.exports = {
  ensureMetaSetupForWorkspace,
  apiKeyStatus,
  requestApiKeyOtp,
  verifyApiKeyOtp,
};


