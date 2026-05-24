const { verifyWebhookSignature } = require("@core/middleware/webhookSignature");
const { verify, receive } = require("@modules/webhooks/controllers/webhook.controller");

function registerRoutes(app, basePath = "") {
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
  app.use(`${basePath}/analytics`, require("@core/routes/analyticsRoutes"));
  app.use(`${basePath}/reports`, require("@core/routes/reportsRoutes"));
  app.use(`${basePath}/links`, require("@core/routes/linkRoutes"));
  app.use(`${basePath}/conversations`, require("@core/routes/conversationRoutes"));
  app.use(`${basePath}/contacts`, require("@core/routes/contactRoutes"));
  app.use(`${basePath}/meta`, require("@core/routes/metaRoutes"));
  app.use(`${basePath}/billing`, require("@modules/billing/routes/billing.routes"));
  app.use(`${basePath}/campaigns`, require("@core/routes/campaignRoutes"));
  app.use(`${basePath}/wallet`, require("@core/routes/walletRoutes"));
  app.use(`${basePath}/integrations`, require("@core/routes/integrationRoutes"));
  app.use(`${basePath}/realtime`, require("@core/routes/realtimeRoutes"));
  app.use(`${basePath}/external/chat`, require("@modules/external-chat/routes/externalChat.routes"));
  app.use(`${basePath}/crm`, require("@core/routes/crmRoutes"));
  app.use(`${basePath}`, require("@core/routes/automationRoutes"));
}

module.exports = { registerRoutes };

