const crypto = require("crypto");

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function generateApiKey() {
  return base64Url(crypto.randomBytes(32));
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeApiKeyOtpPurpose(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "rotate") return "rotate";
  if (v === "reveal") return "reveal";
  return "";
}

function buildOtpEmailHtml({ code, title, subtitle }) {
  return `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #0f172a;">
      <h2 style="margin-bottom: 8px;">${title}</h2>
      <p style="margin: 0 0 16px; color: #475569;">${subtitle}</p>
      <div style="font-size: 28px; font-weight: 800; letter-spacing: 8px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; text-align: center;">
        ${code}
      </div>
      <p style="margin-top: 16px; color: #64748b; font-size: 13px;">This code expires in 10 minutes.</p>
    </div>
  `;
}

function isProdEnv() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function shouldReturnAuthDebugTokens() {
  if (isProdEnv()) return false;
  return String(process.env.AUTH_DEV_RETURN_EMAIL_TOKENS || "").toLowerCase() === "true";
}

module.exports = {
  base64Url,
  generateApiKey,
  generateOtpCode,
  normalizeApiKeyOtpPurpose,
  buildOtpEmailHtml,
  isProdEnv,
  shouldReturnAuthDebugTokens,
};

