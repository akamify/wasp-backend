const crypto = require("crypto");
const { authCookieDomain, authCookieSameSite, authSecureCookies } = require("@core/config/env");

const ACCESS_COOKIE = "aiwizchat_at";
const REFRESH_COOKIE = "aiwizchat_rt";
const DEVICE_COOKIE = "aiwizchat_td";

function parseCookies(header = "") {
  const out = {};
  String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return;
      const key = decodeURIComponent(part.slice(0, idx).trim());
      const value = decodeURIComponent(part.slice(idx + 1).trim());
      out[key] = value;
    });
  return out;
}

function getCookie(req, key) {
  return parseCookies(req?.headers?.cookie || "")[key] || "";
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    secure: !!authSecureCookies,
    sameSite: authCookieSameSite,
    path: "/",
    ...(authCookieDomain ? { domain: authCookieDomain } : {}),
    ...(typeof maxAge === "number" ? { maxAge } : {}),
  };
}

function readAuthCookies(req) {
  return {
    accessToken: getCookie(req, ACCESS_COOKIE),
    refreshToken: getCookie(req, REFRESH_COOKIE),
    trustedDeviceId: getCookie(req, DEVICE_COOKIE),
  };
}

function setAuthCookies(res, { accessToken, refreshToken, refreshMaxAgeMs }) {
  res.cookie(ACCESS_COOKIE, accessToken, cookieOptions(15 * 60 * 1000));
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions(refreshMaxAgeMs));
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions());
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
}

function ensureTrustedDeviceCookie(req, res, maxAgeMs = 15 * 24 * 60 * 60 * 1000) {
  const existing = getCookie(req, DEVICE_COOKIE);
  if (existing) return existing;
  const created = crypto.randomBytes(32).toString("hex");
  res.cookie(DEVICE_COOKIE, created, cookieOptions(maxAgeMs));
  return created;
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  DEVICE_COOKIE,
  readAuthCookies,
  setAuthCookies,
  clearAuthCookies,
  ensureTrustedDeviceCookie,
};
