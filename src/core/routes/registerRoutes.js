const { verifyWebhookSignature, verifyMetaSignature } = require("@core/middleware/webhookSignature");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { verify, receive } = require("@modules/webhooks/controllers/webhook.controller");

function registerRoutes(app, basePath = "") {
  app.post(`${basePath}/internal/debug/webhook-signature-test`, (req, res) => {
    const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
    if (isProd) {
      return res.status(404).json({ success: false, message: "Not found" });
    }

    let secret = "";
    try {
      secret = getMetaAppConfig().metaAppSecret;
    } catch {
      secret = "";
    }

    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const signature = String(req.headers["x-hub-signature-256"] || "").trim();
    const verified = !!secret && verifyMetaSignature({ rawBody, signature, secret });

    return res.json({
      success: true,
      signatureVerified: verified,
      hasSignature: !!signature,
      rawBodyLength: rawBody.length,
      usingMetaAppSecretPresent: !!secret,
    });
  });

  app.use(`${basePath}/public`, require("@core/routes/publicRoutes"));
  app.use(`${basePath}`, require("@core/routes/trackingRoutes"));
  app.use(`${basePath}/webhooks`, require("@core/routes/webhookRoutes"));

  app.get(`${basePath}/webhook`, verify);
  app.post(`${basePath}/webhook`, verifyWebhookSignature, receive);

  app.use(`${basePath}/auth`, require("@core/routes/authRoutes"));
  app.use(`${basePath}/api-keys`, require("@modules/api-keys/routes/apiKey.routes"));
  app.use(`${basePath}/admin`, require("@core/routes/adminRoutes"));
  app.use(`${basePath}/super-admin`, require("@modules/super-admin/routes/superAdmin.routes"));
  app.use(`${basePath}/workspaces`, require("@core/routes/workspaceRoutes"));
  app.use(`${basePath}/credentials`, require("@core/routes/credentialRoutes"));
  app.use(`${basePath}/templates`, require("@core/routes/templateRoutes"));
  app.use(`${basePath}/messages`, require("@core/routes/messageRoutes"));
  app.use(`${basePath}/media`, require("@modules/media/routes/media.routes"));
  app.use(`${basePath}/analytics`, require("@core/routes/analyticsRoutes"));
  app.use(`${basePath}/reports`, require("@core/routes/reportsRoutes"));
  app.use(`${basePath}/links`, require("@core/routes/linkRoutes"));
  app.use(`${basePath}/conversations`, require("@core/routes/conversationRoutes"));
  app.use(`${basePath}/contacts`, require("@core/routes/contactRoutes"));
  app.use(`${basePath}/meta`, require("@core/routes/metaRoutes"));
  app.use(`${basePath}/billing`, require("@modules/billing/routes/billing.routes"));
  app.use(`${basePath}/campaigns`, require("@core/routes/campaignRoutes"));
  app.use(`${basePath}/flows`, require("@modules/flows/routes/flows.routes"));
  app.use(`${basePath}/preferences`, require("@modules/preferences/routes/preferences.routes"));
  app.use(`${basePath}/wallet`, require("@core/routes/walletRoutes"));
  app.use(`${basePath}/integrations`, require("@core/routes/integrationRoutes"));
  app.use(`${basePath}/integrations/whatsapp`, require("@core/routes/whatsappIntegrationRoutes"));
  app.use(`${basePath}/realtime`, require("@core/routes/realtimeRoutes"));
  app.use(`${basePath}/external/chat`, require("@modules/external-chat/routes/externalChat.routes"));
  app.use(`${basePath}/crm`, require("@core/routes/crmRoutes"));
  app.use(`${basePath}`, require("@core/routes/automationRoutes"));
}

module.exports = { registerRoutes };

