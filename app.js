const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimiters = require("./middleware/rateLimiters");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const { appBrandName, corsOrigins } = require("./config/env");

const app = express();

// If you're behind a reverse proxy (Render, Heroku, Nginx), this helps IP-based rate limits/logging.
app.set("trust proxy", 1);
app.disable("x-powered-by");

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
      return cb(null, Array.isArray(corsOrigins) && corsOrigins.includes(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-workspace-id"],
    maxAge: 86400,
  })
);
app.use(morgan("dev"));

app.get("/", (req, res) =>
  res.json({
    success: true,
    message: `${appBrandName} API is running`,
    health: "/health",
    apiHealth: "/api/health",
  })
);
app.get("/health", (req, res) => res.json({ ok: true }));

function mountRoutes(basePath = "") {
  // Public tracking + webhooks
  app.use(`${basePath}`, require("./routes/trackingRoutes"));
  app.use(`${basePath}/webhooks`, require("./routes/webhookRoutes"));

  // Common webhook callback aliases (many setups use `/webhook` directly).
  // These must remain public (no auth) and support the Meta verification handshake.
  // Mounted for both `/` and `/api` base paths.
  // NOTE: We mount handlers directly (instead of re-mounting the router) so that
  // `GET/POST {basePath}/webhook` works (not `{basePath}/webhook/webhook`).
  // eslint-disable-next-line global-require
  const { verifyWebhookSignature } = require("./middleware/webhookSignature");
  // eslint-disable-next-line global-require
  const { verify, receive } = require("./controllers/webhookController");
  app.get(`${basePath}/webhook`, verify);
  app.post(`${basePath}/webhook`, verifyWebhookSignature, receive);

  
  // Auth + tenant routes
  app.use(`${basePath}/auth`, require("./routes/authRoutes"));
  app.use(`${basePath}/admin`, require("./routes/adminRoutes"));
  app.use(`${basePath}/workspaces`, require("./routes/workspaceRoutes"));
  app.use(`${basePath}/credentials`, require("./routes/credentialRoutes"));
  app.use(`${basePath}/templates`, require("./routes/templateRoutes"));
  app.use(`${basePath}/messages`, require("./routes/messageRoutes"));
  app.use(`${basePath}/analytics`, require("./routes/analyticsRoutes"));
  app.use(`${basePath}/reports`, require("./routes/reportsRoutes"));
  app.use(`${basePath}/links`, require("./routes/linkRoutes"));
  app.use(`${basePath}/conversations`, require("./routes/conversationRoutes"));
  app.use(`${basePath}/contacts`, require("./routes/contactRoutes"));
  app.use(`${basePath}/meta`, require("./routes/metaRoutes"));
  app.use(`${basePath}/campaigns`, require("./routes/campaignRoutes"));
  app.use(`${basePath}/wallet`, require("./routes/walletRoutes"));
  app.use(`${basePath}/integrations`, require("./routes/integrationRoutes"));
  app.use(`${basePath}`, require("./routes/automationRoutes")); // mounts POST /trigger-event
}

app.use(rateLimiters.general);
mountRoutes("");
app.get("/api/health", (req, res) => res.json({ ok: true }));
mountRoutes("/api");

app.use(notFound);
app.use(errorHandler);

module.exports = app;
