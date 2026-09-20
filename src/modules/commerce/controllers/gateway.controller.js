const service = require("../services/gateway.service");
const schemas = require("../validators/gateway.validators");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { SESSION_MS } = require("../domain/gateway");
const { oauthReturnUrl } = require("../domain/oauthReturn");
const cookieName = (state) => `__Host-commerce_oauth_${state.slice(0, 16)}`;
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };
function nonceCookie(req, state) {
  const name = cookieName(state);
  const values = String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
async function audit(req, action, gateway, workspaceId = req.workspace?.id) {
  await writeAuditLog(req, { action, resourceType: "commerce_gateway", resourceId: gateway?.id,
    metadata: { workspaceId, environment: gateway?.environment, authType: gateway?.authType, revision: gateway?.revision } });
}
const id = (req) => schemas.parse(schemas.objectId.required(), req.params.gatewayId);
async function list(req, res) { res.json({ success: true, gateways: await service.list(req.workspace.id) }); }
async function get(req, res) { res.json({ success: true, gateway: await service.get(req.workspace.id, id(req)) }); }
async function manual(req, res) {
  const input = schemas.parse(schemas.manual, req.body || {});
  const gateway = await service.connectManual(req.workspace.id, req.user.id, input);
  await audit(req, "commerce_gateway_connected", gateway);
  res.status(201).json({ success: true, gateway });
}
async function startOAuth(req, res) {
  const result = await service.startOAuth(req.workspace.id, req.user.id, schemas.parse(schemas.oauthStart, req.body || {}));
  res.cookie(cookieName(result.state), result.nonce, { ...cookieOptions, maxAge: SESSION_MS });
  res.json({ success: true, authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt });
}
async function finishOAuth(req, res) {
  const query = schemas.parse(schemas.callback, req.query);
  res.clearCookie(cookieName(query.state), cookieOptions);
  const result = await service.finishOAuth(req.user.id, query, nonceCookie(req, query.state));
  if (result.gateway) await audit(req, "commerce_gateway_connected", result.gateway, result.workspaceId);
  const redirect = oauthReturnUrl(result);
  if (redirect && req.accepts(["json", "html"]) === "html") return res.redirect(303, redirect);
  res.json({ success: true, ...result });
}
function change(action) {
  return async (req, res) => {
    const gateway = await service[action](req.workspace.id, id(req), schemas.parse(schemas.revisionBody, req.body || {}));
    await audit(req, `commerce_gateway_${action}`, gateway);
    res.json({ success: true, gateway });
  };
}
async function revokeWebhook(req, res) {
  await service.receiveRevocation(req.params.environment, req.body, req.headers["x-razorpay-signature"]);
  res.json({ success: true });
}
module.exports = { list, get, manual, startOAuth, finishOAuth, change, revokeWebhook, cookieName, nonceCookie };
