const express = require("express");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireWorkspacePermission } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { HttpError } = require("@shared/utils/httpError");
const rateLimiters = require("@core/middleware/rateLimiters");
const readiness = require("../services/gatewayReadiness.service");
const controller = require("../controllers/gateway.controller");
const router = express.Router();
const safe = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch((error) => {
  next(error instanceof HttpError ? error : new HttpError(503, "Commerce gateway operation failed. Check status before retrying."));
});
const ready = safe(async (_req, _res, next) => { await readiness.assertGatewayReady(); next(); });
router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
// Raw parser is installed before the application's JSON parser. HMAC authenticates these public events.
router.post("/oauth/webhooks/:environment", ready, safe(controller.revokeWebhook));
// A callback uses the session's workspace, not the browser's currently selected workspace.
router.get("/oauth/callback", auth, rateLimiters.ecommerceConnect, ready, safe(controller.finishOAuth));
router.use(auth, requireWorkspace, requireWorkspacePermission("commerce.gateway.manage"), ready);
router.use((req, _res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json"))
    return next(new HttpError(415, "Gateway changes require application/json."));
  next();
});
router.get("/", rateLimiters.ecommerceRead, safe(controller.list));
router.get("/:gatewayId", rateLimiters.ecommerceRead, safe(controller.get));
router.post("/manual", rateLimiters.ecommerceConnect, safe(controller.manual));
router.post("/oauth/start", rateLimiters.ecommerceConnect, safe(controller.startOAuth));
router.post("/:gatewayId/verify", rateLimiters.ecommerceConnect, safe(controller.change("verify")));
router.post("/:gatewayId/native", rateLimiters.ecommerceConnect, safe(async (req, res) => {
  const Joi = require("joi"), { parse, objectId, revisionBody } = require("../validators/orders.validators");
  const id = parse(objectId.required(), req.params.gatewayId);
  const input = parse(Joi.object({ revision: revisionBody.extract("revision"), configurationName: Joi.string().max(60).required() }), req.body || {});
  const result = await require("../services/nativePayments.service").configure(req.workspace.id, id, req.user.id, input);
  await require("@shared/services/auditLog.service").writeAuditLog(req, { action: "commerce_native_configuration_verified", resourceType: "commerce_gateway",
    resourceId: id, metadata: { workspaceId: req.workspace.id } });
  res.json({ success: true, ...result });
}));
router.post("/:gatewayId/disconnect", rateLimiters.ecommerceConnect, safe(controller.change("disconnect")));
module.exports = router;
