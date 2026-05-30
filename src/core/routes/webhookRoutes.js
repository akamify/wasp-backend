const express = require("express");
const { asyncHandler } = require("@shared/utils/asyncHandler");
const { verifyWebhookSignature, verifyMetaSignature } = require("@core/middleware/webhookSignature");
const { verify, receive, listWebhookDebugEvents } = require("@modules/webhooks/controllers/webhook.controller");
const { razorpayWebhook } = require("@modules/wallet/controllers/wallet.controller");
const { lookupSecret } = require("@core/config/env");

const router = express.Router();

// Simple healthcheck endpoint for validating that Meta can reach this service.
router.get("/ping", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
router.get("/debug/last", (req, res, next) => {
  const token = String(req.query.token || "");
  const workspaceId = String(req.query.workspaceId || "");
  if (!lookupSecret || token !== lookupSecret) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  if (!workspaceId) {
    return res.status(400).json({ success: false, message: "Missing workspaceId" });
  }
  return next();
}, asyncHandler(listWebhookDebugEvents));
router.post("/debug/webhook-signature-test", (req, res) => {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const token = String(req.headers["x-debug-token"] || req.body?.token || "");
  if (isProd && (!lookupSecret || token !== lookupSecret)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const rawBodyText = String(req.body?.rawBody || "");
  const signature = String(req.body?.signature || "");
  const secret = String(process.env.META_APP_SECRET || process.env.APP_SECRET || "").trim();
  const rawBody = Buffer.from(rawBodyText, "utf8");
  const verified = !!secret && verifyMetaSignature({ rawBody, signature, secret });
  return res.json({
    success: true,
    route: "/debug/webhook-signature-test",
    hasSignature: !!signature,
    rawBodyLength: rawBody.length,
    expectedLength: secret ? Buffer.byteLength(`sha256=${require("crypto").createHmac("sha256", secret).update(rawBody).digest("hex")}`) : 0,
    receivedLength: signature ? Buffer.byteLength(signature) : 0,
    usingMetaAppSecretPresent: !!secret,
    signatureVerified: verified,
  });
});

router.get("/whatsapp", asyncHandler(verify));
router.post("/whatsapp", verifyWebhookSignature, asyncHandler(receive));
// Centralized Meta WhatsApp callback path used in platform onboarding docs/UI.
router.get("/meta/whatsapp", asyncHandler(verify));
router.post("/meta/whatsapp", verifyWebhookSignature, asyncHandler(receive));
// Alias paths (common in tutorials / older setups)
router.get("/webhook", asyncHandler(verify));
router.post("/webhook", verifyWebhookSignature, asyncHandler(receive));
router.post("/razorpay", asyncHandler(razorpayWebhook));

module.exports = router;


