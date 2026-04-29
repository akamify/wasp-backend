const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { verifyWebhookSignature } = require("../middleware/webhookSignature");
const { verify, receive } = require("../controllers/webhookController");
const { razorpayWebhook } = require("../controllers/walletController");

const router = express.Router();

router.get("/whatsapp", asyncHandler(verify));
router.post("/whatsapp", verifyWebhookSignature, asyncHandler(receive));
router.post("/razorpay", asyncHandler(razorpayWebhook));

module.exports = router;

