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

const app = express();

// If you're behind a reverse proxy (Render, Heroku, Nginx), this helps IP-based rate limits/logging.
app.set("trust proxy", 1);
app.disable("x-powered-by");
// API is dynamic; avoid 304/ETag surprises that can lead to empty bodies in XHR clients.
app.set("etag", false);

// Capture raw body for webhook signature verification.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false }));

const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
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
