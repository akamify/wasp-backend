const crypto = require("node:crypto");
const { HttpError } = require("@shared/utils/httpError");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("hex");
const SESSION_MS = 10 * 60 * 1000;
const REFRESH_LEASE_MS = 120000;
function gatewayDto(record) {
  return Object.fromEntries(["provider", "environment", "authType", "keyLabel", "merchantAccountId",
    "identityVerified", "active", "status", "credentialsVerifiedAt", "tokenExpiresAt", "refreshState",
    "webhookStatus", "lastWebhookAt", "previousWebhookSecretExpiresAt", "nativePaymentStatus", "nativeConfigurationName", "lastErrorCode", "revision", "createdAt"]
    .map((key) => [key, record[key]]).concat([["id", String(record._id)]]));
}
function tokenFields(data, environment, now, expectedAccountId) {
  const invalid = () => { throw new HttpError(502, "Razorpay returned an invalid token response."); };
  const ttl = Number(data?.expires_in);
  if (String(data?.token_type).toLowerCase() !== "bearer" || !Number.isSafeInteger(ttl) || ttl < 120 || ttl > 366 * 86400
      || ![data.access_token, data.refresh_token].every((v) => typeof v === "string" && v.length > 0 && v.length <= 16384)
      || typeof data.public_token !== "string" || !new RegExp(`^rzp_${environment}_oauth_[a-zA-Z0-9]+$`).test(data.public_token)) invalid();
  const account = data.razorpay_account_id || expectedAccountId;
  if (typeof account !== "string" || !/^acc_[a-zA-Z0-9]{1,64}$/.test(account)
      || (expectedAccountId && account !== expectedAccountId)) invalid();
  return { accessToken: data.access_token, refreshToken: data.refresh_token, merchantAccountId: account,
    keyLabel: `••••${data.public_token.slice(-4)}`, tokenExpiresAt: new Date(now.getTime() + ttl * 1000),
    refreshAfter: new Date(now.getTime() + Math.max(60, ttl - Math.min(3600, Math.floor(ttl / 10))) * 1000) };
}
function validSignature(raw, signature, secrets) {
  if (!Buffer.isBuffer(raw) || !raw.length || typeof signature !== "string" || !/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const supplied = Buffer.from(signature, "hex");
  return secrets.some((secret) => crypto.timingSafeEqual(crypto.createHmac("sha256", secret).update(raw).digest(), supplied));
}
module.exports = { hash, randomToken, SESSION_MS, REFRESH_LEASE_MS, gatewayDto, tokenFields, validSignature };
