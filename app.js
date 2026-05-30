require("module-alias/register");
// Load env here as well (index.js already does this) so that running the app
// via `node app.js` or `require('./app')` still has JWT/config available.
require("@core/config/loadEnv").loadEnv();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimiters = require("@core/middleware/rateLimiters");
const { notFound, errorHandler } = require("@core/middleware/errorHandler");
const { appBrandName, corsOrigins } = require("@core/config/env");
const { registerRoutes } = require("@core/routes/registerRoutes");
const { verifyWebhookSignature } = require("@core/middleware/webhookSignature");
const { receive } = require("@modules/webhooks/controllers/webhook.controller");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");

const app = express();

// If you're behind a reverse proxy (Render, Heroku, Nginx), this helps IP-based rate limits/logging.
app.set("trust proxy", 1);
app.disable("x-powered-by");
// API is dynamic; avoid 304/ETag surprises that can lead to empty bodies in XHR clients.
app.set("etag", false);

const rawWebhook = express.raw({ type: "*/*" });
const webhookPostHandler = [rawWebhook, verifyWebhookSignature, receive];
app.post("/webhooks/meta/whatsapp", ...webhookPostHandler);
app.post("/api/webhooks/meta/whatsapp", ...webhookPostHandler);
app.post("/webhooks/whatsapp", ...webhookPostHandler);
app.post("/api/webhooks/whatsapp", ...webhookPostHandler);
app.post("/webhook", ...webhookPostHandler);
app.post("/api/webhook", ...webhookPostHandler);

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const { metaAppId: startupMetaAppId, metaAppSecret: startupMetaAppSecret, metaAppSecretSource } = getMetaAppConfig();
const startupTokenEncSecret = String(process.env.TOKEN_ENCRYPTION_SECRET || "").trim();
if (!startupMetaAppSecret || startupMetaAppSecret.length < 12) {
  throw new Error("META_APP_SECRET is missing or too short. Webhook signature verification cannot run safely.");
}
// eslint-disable-next-line no-console
console.info("[startup] env status", {
  metaAppId: startupMetaAppId,
  metaAppSecretSource,
  metaAppSecretLength: startupMetaAppSecret.length,
  hasMetaWebhookVerifyToken: !!String(process.env.META_WEBHOOK_VERIFY_TOKEN || "").trim(),
  tokenEncryptionSecretLength: startupTokenEncSecret.length,
  metaGraphVersion: String(process.env.META_GRAPH_VERSION || "v22.0"),
});
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));
const normalizedCorsOrigins = Array.isArray(corsOrigins)
  ? corsOrigins.map((origin) => String(origin || "").trim().replace(/\/+$/, "")).filter(Boolean)
  : [];
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "frame-ancestors": ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
if (isProd) {
  app.use(
    helmet.hsts({
      maxAge: 15552000,
      includeSubDomains: true,
      preload: true,
    })
  );
}
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // non-browser clients
      if (!isProd) return cb(null, true);
      const normalizedOrigin = String(origin || "").trim().replace(/\/+$/, "");
      const allowed = normalizedCorsOrigins.includes(normalizedOrigin);
      if (!allowed) {
        console.warn(`[CORS] Blocked origin: ${normalizedOrigin}. Allowed: ${normalizedCorsOrigins.join(", ") || "(none)"}`);
      }
      return cb(null, allowed);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
    maxAge: 86400,
  })
);
app.use(morgan("dev"));

// Disable caching for API JSON responses (prevents stale UI + 304 with empty body on some clients).
app.use((req, res, next) => {
  // Keep media endpoints cacheable by browsers/CDNs.
  if (req.path.includes("/messages/media/") || req.path.includes("/tracking/")) return next();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return next();
});

app.get("/", (req, res) =>
  res.json({
    success: true,
    message: `${appBrandName} API is running`,
    health: "/health",
    apiHealth: "/api/health",
  })
);
app.get("/health", (req, res) => res.json({ ok: true }));

app.use(rateLimiters.general);
registerRoutes(app, "");
app.get("/api/health", (req, res) => res.json({ ok: true }));
registerRoutes(app, "/api");

app.use(notFound);
app.use(errorHandler);

module.exports = app;
