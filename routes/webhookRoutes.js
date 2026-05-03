const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { verifyWebhookSignature } = require("../middleware/webhookSignature");
const { verify, receive } = require("../controllers/webhookController");
const { razorpayWebhook } = require("../controllers/walletController");

const router = express.Router();

// Simple healthcheck endpoint for validating that Meta can reach this service.
router.get("/ping", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

router.get("/whatsapp", asyncHandler(verify));
router.post("/whatsapp", verifyWebhookSignature, asyncHandler(receive));
router.post("/razorpay", asyncHandler(razorpayWebhook));

module.exports = router;

