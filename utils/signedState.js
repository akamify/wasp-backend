const crypto = require("crypto");
const { lookupSecret } = require("../config/env");

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(str) {
  const s = String(str || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = s + "===".slice((s.length + 3) % 4);
  return Buffer.from(padded, "base64");
}

function hmac(payload) {
  if (!lookupSecret) return "";
  return crypto.createHmac("sha256", lookupSecret).update(payload).digest("hex");
}

function signState(obj) {
  const json = JSON.stringify(obj || {});
  const payload = base64UrlEncode(json);
  const sig = hmac(payload);
  return `${payload}.${sig}`;
}

function verifyState(state) {
  const [payload, sig] = String(state || "").split(".");
  if (!payload || !sig) return { ok: false, error: "Invalid state" };
  if (!lookupSecret) return { ok: false, error: "LOOKUP_SECRET not configured" };

  const expected = hmac(payload);
  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) return { ok: false, error: "Invalid state signature" };

  try {
    const json = base64UrlDecode(payload).toString("utf8");
    const value = JSON.parse(json);
    return { ok: true, value };
  } catch {
    return { ok: false, error: "Invalid state payload" };
  }
}

module.exports = { signState, verifyState };

