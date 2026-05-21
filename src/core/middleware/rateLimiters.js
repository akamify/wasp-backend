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
const externalChatReadWindowMs = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_READ_WINDOW_MS, 60 * 1000);
const externalChatReadLimit = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_READ_MAX, isProd ? 120 : 1200);
const externalChatSendWindowMs = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_SEND_WINDOW_MS, 60 * 1000);
const externalChatSendLimit = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_SEND_MAX, isProd ? 30 : 300);
const externalChatUploadWindowMs = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_UPLOAD_WINDOW_MS, 60 * 1000);
const externalChatUploadLimit = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_UPLOAD_MAX, isProd ? 10 : 100);
const externalChatTokenWindowMs = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_TOKEN_WINDOW_MS, 60 * 60 * 1000);
const externalChatTokenLimit = toNumber(process.env.RATE_LIMIT_EXTERNAL_CHAT_TOKEN_MAX, isProd ? 12 : 120);

function authKeyFromHeader(header = "") {
  const token = String(header || "").trim();
  if (!token) return "";
  return crypto.createHash("sha1").update(token).digest("hex").slice(0, 16);
}

function externalApiKeyBucket(req) {
  if (req?.auth?.apiKeyId) return `apiKeyId:${String(req.auth.apiKeyId)}`;
  const apiKey = String(req?.headers?.["x-api-key"] || "").trim();
  if (apiKey) return `apiKey:${authKeyFromHeader(apiKey)}`;
  return ipKeyGenerator(req);
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

function externalChatLimiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: externalApiKeyBucket,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: "Too many requests, please try again in a moment.",
    },
  });
}

const externalChatRead = externalChatLimiter(externalChatReadWindowMs, externalChatReadLimit);
const externalChatSend = externalChatLimiter(externalChatSendWindowMs, externalChatSendLimit);
const externalChatUpload = externalChatLimiter(externalChatUploadWindowMs, externalChatUploadLimit);
const externalChatRealtimeToken = externalChatLimiter(externalChatTokenWindowMs, externalChatTokenLimit);

module.exports = {
  general,
  auth,
  login,
  otp,
  automationTrigger,
  metaFlowOps,
  externalChatRead,
  externalChatSend,
  externalChatUpload,
  externalChatRealtimeToken,
};
