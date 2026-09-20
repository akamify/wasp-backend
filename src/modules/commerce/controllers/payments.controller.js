const service = require("../services/payments.service");
const webhooks = require("../services/paymentWebhooks.service");
const schemas = require("../validators/payments.validators");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const id = (req) => schemas.parse(schemas.objectId.required(), req.params.orderId || req.params.attemptId || req.params.gatewayId || req.params.paymentId || req.params.eventId);
async function audit(req, action, record) {
  await writeAuditLog(req, { action, resourceType: "commerce_payment", resourceId: record?.id,
    metadata: { workspaceId: req.workspace.id, status: record?.status } });
}
async function checkout(req, res) {
  const attempt = await service.checkout(req.workspace.id, id(req), req.user.id, schemas.parse(schemas.checkout, req.body || {}));
  await audit(req, "commerce_checkout_requested", attempt); res.status(202).json({ success: true, attempt });
}
const read = (action) => async (req, res) => res.json({ success: true, ...await service[action](req.workspace.id, req.query) });
const orderRead = (action) => async (req, res) => res.json({ success: true, ...await service[action](req.workspace.id, id(req), req.query) });
async function attempt(req, res) { res.json({ success: true, attempt: await service.getAttempt(req.workspace.id, id(req)) }); }
const change = (action) => async (req, res) => {
  schemas.parse(schemas.emptyBody, req.body || {});
  const record = await service[action](req.workspace.id, id(req));
  await audit(req, `commerce_payment_${action}`, record); res.status(202).json({ success: true, record });
};
async function settings(req, res) { res.json({ success: true, settings: await service.settings(req.workspace.id) }); }
async function changeSettings(req, res) {
  const settings = await service.changeSettings(req.workspace.id, req.body || {});
  await audit(req, "commerce_payment_settings_updated", settings); res.json({ success: true, settings });
}
async function configure(req, res) {
  const result = await webhooks.configure(req.workspace.id, id(req), req.body || {});
  await audit(req, "commerce_payment_webhook_rotated", result.gateway); res.json({ success: true, ...result });
}
async function receive(req, res) {
  res.json({ success: true, ...await webhooks.receive(id(req), req.body, req.headers["x-razorpay-signature"], req.headers["x-razorpay-event-id"]) });
}
async function verifyIdentity(req, res) {
  const gateway = await webhooks.verifyManualIdentity(req.workspace.id, id(req), req.user.id, req.body || {});
  await audit(req, "commerce_manual_gateway_identity_verified", gateway); res.json({ success: true, gateway });
}
module.exports = { checkout, read, orderRead, attempt, change, settings, changeSettings, configure, receive, verifyIdentity };
