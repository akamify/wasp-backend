const crypto = require("crypto");

function base64UrlEncode(bufOrStr) {
  const buf = Buffer.isBuffer(bufOrStr) ? bufOrStr : Buffer.from(bufOrStr);
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecodeToString(str) {
  const b64 = str.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getTrackingSecret() {
  return process.env.TRACKING_SECRET || process.env.JWT_SECRET || "";
}

function sign(bodyB64Url) {
  const secret = getTrackingSecret();
  if (!secret) throw new Error("Missing TRACKING_SECRET (or JWT_SECRET)");
  const sig = crypto.createHmac("sha256", secret).update(bodyB64Url).digest();
  return base64UrlEncode(sig);
}

function createTrackingCode(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(body);
  return `${body}.${signature}`;
}

function verifyAndDecodeTrackingCode(code) {
  const [body, signature] = String(code).split(".");
  if (!body || !signature) {
    return { ok: false, error: "Invalid tracking code format" };
  }

  const expected = sign(body);
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, error: "Invalid tracking code signature" };
  }

  try {
    const json = base64UrlDecodeToString(body);
    return { ok: true, payload: JSON.parse(json) };
  } catch {
    return { ok: false, error: "Invalid tracking code payload" };
  }
}

module.exports = { createTrackingCode, verifyAndDecodeTrackingCode };

