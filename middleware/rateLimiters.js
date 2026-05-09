const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const crypto = require("crypto");

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const generalWindowMs = toNumber(process.env.RATE_LIMIT_GENERAL_WINDOW_MS, 60 * 1000);
const generalAnonLimit = toNumber(process.env.RATE_LIMIT_GENERAL_MAX_ANON, isProd ? 120 : 1000);
const generalAuthLimit = toNumber(process.env.RATE_LIMIT_GENERAL_MAX_AUTH, isProd ? 360 : 3000);

const authWindowMs = toNumber(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000);
const authLimit = toNumber(process.env.RATE_LIMIT_AUTH_MAX, isProd ? 5 : 50);

function authKeyFromHeader(header = "") {
  const token = String(header || "").trim();
  if (!token) return "";
  return crypto.createHash("sha1").update(token).digest("hex").slice(0, 16);
}

const general = rateLimit({
  windowMs: generalWindowMs,
  limit: (req) => {
    // Authenticated dashboards fan out many GET calls every few seconds.
    // Keep stricter bucket for anonymous/public traffic.
    const hasAuth = Boolean(req.headers.authorization || req.headers["x-api-key"]);
    return hasAuth ? generalAuthLimit : generalAnonLimit;
  },
  keyGenerator: (req) => {
    const authHeader = req.headers.authorization || req.headers["x-api-key"] || "";
    const authKey = authKeyFromHeader(authHeader);
    if (authKey) return `auth:${authKey}`;
    return ipKeyGenerator(req);
  },
  skip: (req) => req.method === "OPTIONS",
  message: {
    success: false,
    message: "Too many requests, please try again in a moment.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const auth = rateLimit({
  windowMs: authWindowMs,
  limit: authLimit,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { general, auth };
