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
  adminSessionExpiresIn: process.env.ADMIN_SESSION_EXPIRES_IN || "1d",
  adminEmail: process.env.ADMIN_EMAIL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminName: process.env.ADMIN_NAME || "Whasp Admin",
  appBrandName: process.env.APP_BRAND_NAME || "DigitalWhasp",
  appBaseUrl: process.env.APP_BASE_URL || `http://localhost:${port}`,
  metaGraphVersion: process.env.META_GRAPH_VERSION || "v22.0",
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  metaAppSecret: process.env.META_APP_SECRET || "",
  lookupSecret: process.env.LOOKUP_SECRET || "",
  trackingBaseUrl:
    process.env.TRACKING_BASE_URL || process.env.APP_BASE_URL || `http://localhost:${port}`,
};

