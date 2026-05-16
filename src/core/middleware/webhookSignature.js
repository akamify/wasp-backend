const crypto = require("crypto");
const { metaAppSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");

function safeEqualHex(a, b) {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyWebhookSignature(req, res, next) {
  // Allow bypassing signature verification for local debugging only.
  // Never enable this in production.
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (String(process.env.META_WEBHOOK_SKIP_SIGNATURE || "").toLowerCase() === "true") {
    if (isProd) {
      return next(new HttpError(500, "META_WEBHOOK_SKIP_SIGNATURE cannot be enabled in production"));
    }
    return next();
  }

  // In non-production, signature validation is best-effort to avoid blocking local dev
  // when the callback URL is proxied / test tools omit signature headers.
  if (!metaAppSecret) {
    if (!isProd) return next(); // signature verification optional in dev/test
    return next(new HttpError(500, "META_APP_SECRET is required to verify webhook signatures"));
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || typeof signature !== "string") {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook signature missing (x-hub-signature-256).");
    }
    if (!isProd) return next();
    return next(new HttpError(401, "Missing X-Hub-Signature-256 header"));
  }

  const rawBody = req.rawBody;
  if (!rawBody) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook rawBody missing. Ensure express.json verify() is configured.");
    }
    if (!isProd) return next();
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
    if (!isProd) return next();
    return next(new HttpError(401, "Invalid webhook signature"));
  }

  return next();
}

module.exports = { verifyWebhookSignature };

