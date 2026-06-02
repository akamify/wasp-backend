const crypto = require("crypto");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { HttpError } = require("@shared/utils/httpError");

function verifyMetaSignature({ rawBody, signature, secret }) {
  if (!rawBody || !Buffer.isBuffer(rawBody)) return false;
  if (!signature || typeof signature !== "string") return false;
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSignature.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  if (Buffer.byteLength(normalizedSignature) !== Buffer.byteLength(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expected));
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
  let metaAppId = "";
  let signingSecret = "";
  try {
    const cfg = getMetaAppConfig();
    metaAppId = cfg.metaAppId;
    signingSecret = cfg.metaAppSecret;
  } catch (cfgErr) {
    if (!isProd) return next(); // signature verification optional in dev/test
    return next(new HttpError(500, "META_APP_SECRET is required to verify webhook signatures"));
  }

  const signature = String(req.headers["x-hub-signature-256"] || "").trim();
  if (!signature || typeof signature !== "string") {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook signature missing (x-hub-signature-256).");
    }
    if (!isProd) return next();
    return next(new HttpError(401, "Missing X-Hub-Signature-256 header"));
  }

  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : null;
  if (!rawBody) {
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.warn("Webhook rawBody missing. Ensure express.json verify() is configured.");
    }
    if (!isProd) return next();
    return next(new HttpError(500, "Missing raw body for signature verification"));
  }

  const verified = verifyMetaSignature({ rawBody, signature, secret: signingSecret });
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", signingSecret).update(rawBody).digest("hex");
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
    // eslint-disable-next-line no-console
    console.info("Webhook signature debug.", {
      route: req.originalUrl || req.url,
      metaAppId,
      hasSignature: !!signature,
      rawBodyLength: rawBody ? rawBody.length : 0,
      expectedLength: expected.length,
      receivedLength: signature ? Buffer.byteLength(signature) : 0,
      usingMetaAppSecretPresent: !!signingSecret,
      signatureVerified: verified,
    });
  }

  if (!verified) {
    // eslint-disable-next-line no-console
    console.warn("[webhook] signature mismatch", {
      route: req.originalUrl || req.url,
      metaAppId,
      hasSignature: true,
      rawBodyLength: rawBody.length,
      expectedLength: expected.length,
      receivedLength: signature.length,
      expectedHashPrefix: expected.replace("sha256=", "").slice(0, 8),
      receivedHashPrefix: signature.replace("sha256=", "").slice(0, 8),
      signatureVerified: false,
    });
    if (!isProd) return next();
    return next(new HttpError(401, "Invalid webhook signature"));
  }

  if (Buffer.isBuffer(req.body)) {
    req.rawBody = rawBody;
    try {
      req.body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return next(new HttpError(400, "Invalid webhook JSON payload"));
    }
  }

  // eslint-disable-next-line no-console
  console.info("[webhook] signature verified", {
    route: req.originalUrl || req.url,
    rawBodyLength: rawBody.length,
    signatureVerified: true,
  });

  return next();
}

module.exports = { verifyWebhookSignature, verifyMetaSignature };

