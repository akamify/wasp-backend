const crypto = require("crypto");
const Razorpay = require("razorpay");
const { getOrCreateWallet, credit } = require("../services/walletService");
const { HttpError } = require("../utils/httpError");

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || "";
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || "";
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

function getRazorpayClient() {
  if (!razorpayKeyId || !razorpayKeySecret) {
    throw new HttpError(
      400,
      "Razorpay credentials not configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)"
    );
  }
  return new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
}

async function getWallet(req, res) {
  const wallet = await getOrCreateWallet(req.workspace.id);
  res.json({ success: true, wallet: { balance: wallet.balance, currency: wallet.currency } });
}

async function createRechargeOrder(req, res) {
  const amount = Number(req.body.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Invalid amount");

  const client = getRazorpayClient();
  const order = await client.orders.create({
    amount: Math.round(amount * 100),
    currency: "INR",
    receipt: `ws_${req.workspace.id}_${Date.now()}`,
    notes: { workspaceId: req.workspace.id },
  });

  res.json({
    success: true,
    order: {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
    },
    keyId: razorpayKeyId,
  });
}

async function razorpayWebhook(req, res) {
  if (!razorpayWebhookSecret) throw new HttpError(400, "RAZORPAY_WEBHOOK_SECRET not configured");

  const signature = req.headers["x-razorpay-signature"];
  if (!signature) throw new HttpError(400, "Missing x-razorpay-signature header");

  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", razorpayWebhookSecret).update(rawBody).digest("hex");
  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw new HttpError(401, "Invalid webhook signature");

  const event = req.body || {};
  if (event.event !== "payment.captured") {
    return res.json({ success: true, ignored: true });
  }

  const payment = event?.payload?.payment?.entity;
  const order = event?.payload?.order?.entity;
  const notes = order?.notes || payment?.notes || {};
  const workspaceId = notes.workspaceId;
  if (!workspaceId) throw new HttpError(400, "workspaceId missing in order notes");

  const amount = Number(payment?.amount || 0) / 100;
  const paymentId = payment?.id || "";

  await credit(
    workspaceId,
    amount,
    "Wallet recharge (Razorpay)",
    "razorpay",
    paymentId,
    { eventId: event?.id || null }
  );

  return res.json({ success: true });
}

module.exports = { getWallet, createRechargeOrder, razorpayWebhook };

