const crypto = require("crypto");
const { metaAppSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");

function getSigningSecret() {
  return String(metaAppSecret || process.env.APP_SECRET || "").trim();
}

function verifyMetaSignature({ rawBody, signature, secret }) {
  if (!rawBody || !Buffer.isBuffer(rawBody)) return false;
  if (!signature || typeof signature !== "string") return false;
  if (!signature.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
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
  const signingSecret = getSigningSecret();
  if (!signingSecret) {
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

  const verified = verifyMetaSignature({ rawBody, signature, secret: signingSecret });
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
    // eslint-disable-next-line no-console
    console.info("Webhook signature debug.", {
      route: req.originalUrl || req.url,
      hasSignature: !!signature,
      rawBodyLength: rawBody ? rawBody.length : 0,
      expectedLength: rawBody ? Buffer.byteLength(`sha256=${crypto.createHmac("sha256", signingSecret).update(rawBody).digest("hex")}`) : 0,
      receivedLength: signature ? Buffer.byteLength(signature) : 0,
      usingMetaAppSecretPresent: !!signingSecret,
      signatureVerified: verified,
    });
  }

  if (!verified) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook signature mismatch.");
    }
    if (!isProd) return next();
    return next(new HttpError(401, "Invalid webhook signature"));
  }

  return next();
}

module.exports = { verifyWebhookSignature, verifyMetaSignature };

