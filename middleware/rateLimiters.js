const rateLimit = require("express-rate-limit");

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const generalWindowMs = toNumber(process.env.RATE_LIMIT_GENERAL_WINDOW_MS, 60 * 1000);
const generalLimit = toNumber(process.env.RATE_LIMIT_GENERAL_MAX, isProd ? 60 : 1000);

const authWindowMs = toNumber(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000);
const authLimit = toNumber(process.env.RATE_LIMIT_AUTH_MAX, isProd ? 5 : 50);

const general = rateLimit({
  windowMs: generalWindowMs,
  limit: generalLimit,
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

