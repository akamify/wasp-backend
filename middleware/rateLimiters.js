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
const loginLimit = toNumber(process.env.RATE_LIMIT_LOGIN_MAX, isProd ? 20 : 100);
const otpLimit = toNumber(process.env.RATE_LIMIT_OTP_MAX, isProd ? 10 : 60);
const automationWindowMs = toNumber(process.env.RATE_LIMIT_AUTOMATION_WINDOW_MS, 60 * 1000);
const automationLimit = toNumber(process.env.RATE_LIMIT_AUTOMATION_MAX, isProd ? 30 : 200);
const metaFlowWindowMs = toNumber(process.env.RATE_LIMIT_META_FLOW_WINDOW_MS, 60 * 1000);
const metaFlowLimit = toNumber(process.env.RATE_LIMIT_META_FLOW_MAX, isProd ? 20 : 120);

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

const login = rateLimit({
  windowMs: authWindowMs,
  limit: loginLimit,
  standardHeaders: true,
  legacyHeaders: false,
  // Legit successful logins should not consume the abuse budget.
  skipSuccessfulRequests: true,
});

const otp = rateLimit({
  windowMs: authWindowMs,
  limit: otpLimit,
  standardHeaders: true,
  legacyHeaders: false,
});

const automationTrigger = rateLimit({
  windowMs: automationWindowMs,
  limit: automationLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "AUTOMATION_RATE_LIMITED",
    message: "Too many automation triggers. Please retry shortly.",
  },
});

const metaFlowOps = rateLimit({
  windowMs: metaFlowWindowMs,
  limit: metaFlowLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "FLOW_RATE_LIMITED",
    message: "Flow operation rate limit reached. Please retry in a minute.",
  },
});

module.exports = { general, auth, login, otp, automationTrigger, metaFlowOps };
