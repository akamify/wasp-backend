// env.js

function requiredInProd(name, fallback = "") {
  const value = process.env[name] || fallback;
  if (process.env.NODE_ENV === "production" && !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT || 3000);

module.exports = {
  port,
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: requiredInProd("JWT_SECRET", "dev_jwt_secret_change_me"),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${port}`,
  clientBaseUrl:
    process.env.CLIENT_BASE_URL ||
    process.env.FRONTEND_BASE_URL ||
    process.env.APP_CLIENT_URL ||
    "http://localhost:5173",
  metaGraphVersion: process.env.META_GRAPH_VERSION || "v22.0",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  metaAppSecret: process.env.META_APP_SECRET || "",
  metaAppId: process.env.APP_ID || process.env.META_APP_ID || "",
  metaAppClientSecret: process.env.APP_SECRET || process.env.META_APP_SECRET || "",
  metaOAuthRedirectUrl:
    process.env.META_OAUTH_REDIRECT_URL || `${process.env.APP_BASE_URL || `http://localhost:${port}`}/auth/meta/callback`,
  lookupSecret: process.env.LOOKUP_SECRET || "",
  trackingBaseUrl:
    process.env.TRACKING_BASE_URL || process.env.APP_BASE_URL || `http://localhost:${port}`,
};

