const service = require("../services/orders.service");
const schemas = require("../validators/orders.validators");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { HttpError } = require("@shared/utils/httpError");
const id = (req) => schemas.parse(schemas.objectId.required(), req.params.orderId || req.params.eventId);
async function audit(req, action, record) {
  await writeAuditLog(req, { action, resourceType: "commerce_order", resourceId: record?.id,
    metadata: { workspaceId: req.workspace.id, revision: record?.revision, status: record?.status } });
}
async function getSettings(req, res) { res.json({ success: true, settings: await service.getSettings(req.workspace.id) }); }
async function changeSettings(req, res) {
  const settings = await service.changeSettings(req.workspace.id, schemas.parse(schemas.settings, req.body || {}));
  await audit(req, "commerce_order_settings_updated", settings);
  res.json({ success: true, settings });
}
async function list(req, res) { res.json({ success: true, ...await service.list(req.workspace.id, schemas.parse(schemas.list, req.query, true)) }); }
async function get(req, res) { res.json({ success: true, order: await service.get(req.workspace.id, id(req)) }); }
async function quote(req, res) { res.json({ success: true, quote: await service.quote(req.workspace.id, id(req)) }); }
function change(action) {
  return async (req, res) => {
    const schema = action === "edit" ? schemas.edit : action === "review" ? schemas.review : schemas.revisionBody;
    const input = schemas.parse(schema, req.body || {});
    const order = action === "review" ? await service.review(req.workspace.id, id(req), req.user.id, input)
      : await service[action](req.workspace.id, id(req), input);
    await audit(req, `commerce_order_${action}`, order);
    res.json({ success: true, order });
  };
}
async function listEvents(req, res) { res.json({ success: true, ...await service.listEvents(req.workspace.id, schemas.parse(schemas.eventList, req.query, true)) }); }
async function retryEvent(req, res) {
  schemas.parse(schemas.emptyBody, req.body || {});
  const event = await service.retryEvent(req.workspace.id, id(req));
  await audit(req, "commerce_order_event_retried", event);
  res.status(202).json({ success: true, event });
}
async function createSession(req, res) {
  const result = await service.createFulfillmentSession(req.workspace.id, id(req), req.user.id, schemas.parse(schemas.revisionBody, req.body || {}));
  await audit(req, "commerce_fulfillment_session_created", { id: id(req) });
  res.status(201).json({ success: true, ...result });
}
function token(req) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || "");
  if (!match) throw new HttpError(401, "A fulfillment session token is required.");
  return match[1];
}
async function getFulfillment(req, res) { res.json({ success: true, fulfillment: await service.getFulfillment(token(req)) }); }
async function submitFulfillment(req, res) {
  res.json({ success: true, ...await service.submitFulfillment(token(req), schemas.parse(schemas.fulfillment, req.body || {})) });
}
module.exports = { getSettings, changeSettings, list, get, quote, change, listEvents, retryEvent, createSession, getFulfillment, submitFulfillment };
