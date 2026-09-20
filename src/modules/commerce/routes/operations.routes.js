const express = require("express");
const Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireWorkspacePermission: permission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const limits = require("@core/middleware/rateLimiters");
const schemas = require("../validators/operations.validators");
const paymentReady = require("../services/paymentsReadiness.service");
const catalogReady = require("../services/catalogReadiness.service");
const gatewayConfig = require("../services/gatewayConfig.service");
const service = require("../services/operations.service");
const messages = require("../services/commerceMessages.service");
const repo = require("../repositories/operations.repository");
const { page } = require("../domain/payments");
const { orderDto } = require("../domain/orders");
const router = express.Router();
router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
const safe = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch((error) => next(error instanceof HttpError ? error : new HttpError(503, "Commerce operation failed. Refresh its status before retrying.")));
const context = [auth, requireWorkspace];
const ready = safe(async (_req, _res, next) => { await paymentReady.assertPaymentsReady(); next(); });
const json = (req, _res, next) => req.is("application/json") ? next() : next(new HttpError(415, "Commerce changes require application/json."));
const id = (value) => schemas.parse(schemas.objectId.required(), value);
const audit = (req, action, record) => writeAuditLog(req, { action, resourceType: "commerce_order", resourceId: record.id,
  metadata: { workspaceId: req.workspace.id, status: record.status } });
router.get("/access", ...context, (req, res) => res.json({ success: true, workspaceId: req.workspace.id, permissions: req.workspace.permissions,
  capabilities: { delivery: process.env.COMMERCE_DELIVERY_ENABLED === "true", catalog: process.env.COMMERCE_CATALOG_ENABLED === "true", orders: process.env.COMMERCE_ORDERS_ENABLED === "true",
    payments: paymentReady.paymentsEnabled(), checkout: paymentReady.checkoutEnabled(), gateway: gatewayConfig.gatewayEnabled(), oauth: gatewayConfig.oauthEnabled(), native: paymentReady.nativeEnabled() } }));
router.get("/orders/inbox", ...context, permission("commerce.orders.view"), ready, limits.ecommerceRead, safe(async (req, res) => {
  const query = schemas.parse(Joi.object({ environment: Joi.string().valid("test", "live").required(), to: Joi.string().pattern(/^[1-9]\d{7,14}$/).required(),
    cursor: schemas.objectId, limit: Joi.number().integer().min(1).max(100).default(25) }), req.query, true);
  res.json({ success: true, ...page(await repo.inboxOrders(req.workspace.id, query, await getCredentialsForUser(req.workspace.id)), query.limit, (o) => orderDto(o)) });
}));
router.post("/orders/:orderId/fulfillment", ...context, permission("commerce.orders.manage"), ready, limits.ecommerceConnect, json, safe(async (req, res) => {
  const order = await service.fulfill(req.workspace.id, id(req.params.orderId), schemas.parse(schemas.fulfillment, req.body || {}), req.user.id);
  await audit(req, "commerce_fulfillment_updated", order); res.json({ success: true, order });
}));
router.post("/notifications/:notificationId/retry", ...context, permission("commerce.messages.send"), ready, limits.ecommerceConnect, json, safe(async (req, res) => {
  schemas.parse(Joi.object({}), req.body || {});
  const notification = await service.retryNotification(req.workspace.id, id(req.params.notificationId), req.user.id);
  await audit(req, "commerce_notification_retried", notification); res.status(202).json({ success: true, notification });
}));
router.post("/messages", ...context, permission("commerce.messages.send"), permission("inbox.reply"), limits.ecommerceConnect, json, safe(async (req, res) => {
  await catalogReady.assertCatalogReady(); const input = schemas.parse(schemas.message, req.body || {});
  if (input.kind === "payment_request") await paymentReady.assertPaymentsReady();
  const message = await messages.send(req.workspace.id, req.user.id, input);
  await audit(req, "commerce_message_sent", message); res.status(202).json({ success: true, message });
}));
module.exports = router;
