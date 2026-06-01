const crypto = require("crypto");
const Razorpay = require("razorpay");
const { HttpError } = require("@shared/utils/httpError");
const { Transaction } = require("@infra/database/Transaction");
const walletCore = require("@modules/wallet/services/wallet.core.service");
const { walletRepository } = require("@modules/wallet/repositories/index");

const razorpayKeyId = process.env.RAZORPAY_KEY_ID || "";
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || "";
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "";

function getRazorpayClient() {
  if (!razorpayKeyId || !razorpayKeySecret) {
    throw new HttpError(400, "Razorpay credentials not configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET)");
  }
  return new Razorpay({ key_id: razorpayKeyId, key_secret: razorpayKeySecret });
}

function buildReceipt(workspaceId) {
  const ws = String(workspaceId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-10) || "ws";
  const ts = Date.now().toString(36);
  return `ws_${ws}_${ts}`.slice(0, 40);
}

async function getWallet(req) {
  const wallet = await walletCore.getOrCreateWallet(req.workspace.id);
  return {
    success: true,
    wallet: {
      workspaceId: String(wallet.workspaceId),
      balance: wallet.balance,
      currency: wallet.currency,
      lastRechargeAt: wallet.lastRechargeAt || null,
    },
  };
}

async function createRechargeOrder(req) {
  const amount = Number(req.body.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "Invalid amount");

  let order;
  try {
    const client = getRazorpayClient();
    order = await client.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: buildReceipt(req.workspace.id),
      notes: { workspaceId: req.workspace.id },
    });
  } catch (err) {
    const providerMessage =
      err?.error?.description ||
      err?.response?.data?.error?.description ||
      err?.response?.data?.error?.reason ||
      err?.message ||
      "Failed to create Razorpay order";
    throw new HttpError(400, "Recharge order creation failed", { providerError: providerMessage });
  }

  return { success: true, order: { id: order.id, amount: order.amount, currency: order.currency }, keyId: razorpayKeyId };
}

async function walletHistory(req) {
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 200);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  const { page, hasMore } = await walletRepository.listTransactionsCursor({ workspaceId: req.workspace.id, limit, cursor });
  return {
    success: true,
    transactions: page.map((t) => ({
      id: String(t._id),
      type: t.type,
      amount: t.amount,
      currency: t.currency,
      reason: t.reason,
      provider: t.provider,
      providerRef: t.providerRef,
      createdAt: t.createdAt,
    })),
    nextCursor: hasMore ? String(page[page.length - 1]?._id) : null,
  };
}

async function razorpayWebhook(req) {
  if (!razorpayWebhookSecret) throw new HttpError(400, "RAZORPAY_WEBHOOK_SECRET not configured");

  const signature = req.headers["x-razorpay-signature"];
  if (!signature) throw new HttpError(400, "Missing x-razorpay-signature header");

  const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
  const expected = crypto.createHmac("sha256", razorpayWebhookSecret).update(rawBody).digest("hex");
  const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw new HttpError(401, "Invalid webhook signature");

  const event = req.body || {};
  if (event.event !== "payment.captured") return { success: true, ignored: true };

  const payment = event?.payload?.payment?.entity;
  const order = event?.payload?.order?.entity;
  const notes = order?.notes || payment?.notes || {};
  const workspaceId = notes.workspaceId;
  if (!workspaceId) throw new HttpError(400, "workspaceId missing in order notes");

  const amount = Number(payment?.amount || 0) / 100;
  const paymentId = payment?.id || "";

  await walletCore.credit(workspaceId, amount, "Wallet recharge (Razorpay)", "razorpay", paymentId, { eventId: event?.id || null });
  return { success: true };
}

module.exports = { getWallet, createRechargeOrder, walletHistory, razorpayWebhook };

