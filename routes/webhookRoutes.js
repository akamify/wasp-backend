const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { verifyWebhookSignature } = require("../middleware/webhookSignature");
const { verify, receive, listWebhookDebugEvents } = require("../controllers/webhookController");
const { razorpayWebhook } = require("../controllers/walletController");
const { lookupSecret } = require("../config/env");

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

router.get("/whatsapp", asyncHandler(verify));
router.post("/whatsapp", verifyWebhookSignature, asyncHandler(receive));
// Alias paths (common in tutorials / older setups)
router.get("/webhook", asyncHandler(verify));
router.post("/webhook", verifyWebhookSignature, asyncHandler(receive));
router.post("/razorpay", asyncHandler(razorpayWebhook));

module.exports = router;

