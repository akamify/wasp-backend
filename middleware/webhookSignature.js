const crypto = require("crypto");
const { metaAppSecret } = require("../config/env");
const { HttpError } = require("../utils/httpError");

function safeEqualHex(a, b) {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyWebhookSignature(req, res, next) {
  // Allow bypassing signature verification for local debugging only.
  // Never enable this in production.
  if (String(process.env.META_WEBHOOK_SKIP_SIGNATURE || "").toLowerCase() === "true") {
    return next();
  }

  if (!metaAppSecret) return next(); // signature verification optional

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || typeof signature !== "string") {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook signature missing (x-hub-signature-256).");
    }
    return next(new HttpError(401, "Missing X-Hub-Signature-256 header"));
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook rawBody missing. Ensure express.json verify() is configured.");
    }
    return next(new HttpError(500, "Missing raw body for signature verification"));
  }

  const expected = crypto
    .createHmac("sha256", metaAppSecret)
    .update(rawBody)
    .digest("hex");

  const provided = signature.startsWith("sha256=")
    ? signature.slice("sha256=".length)
    : signature;

  if (!safeEqualHex(provided, expected)) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook signature mismatch.");
    }
    return next(new HttpError(401, "Invalid webhook signature"));
  }

  return next();
}

module.exports = { verifyWebhookSignature };

