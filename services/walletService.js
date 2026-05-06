const { Wallet } = require("../models/Wallet");
const { Transaction } = require("../models/Transaction");
const { HttpError } = require("../utils/httpError");
const mongoose = require("mongoose");

const COST_PER_MESSAGE = Number(process.env.COST_PER_MESSAGE || 1); // INR
const SEED_BALANCE = Number(process.env.WALLET_SEED_BALANCE || 0);
const MERCHANT_WORKSPACE_ID = String(process.env.MERCHANT_WORKSPACE_ID || "").trim();
const MONEY_PRECISION = 2;

function roundCurrency(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  const rounded = Number(n.toFixed(MONEY_PRECISION));
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

function envFlag(name) {
  const raw = process.env[name];
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return null;
}

function walletChargesEnabled() {
  const explicit = envFlag("WALLET_CHARGES_ENABLED");
  if (explicit !== null) return explicit;
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function perCategoryCost(category) {
  const c = String(category || "").trim().toLowerCase();
  const fallback = COST_PER_MESSAGE;

  if (c === "marketing") {
    const v = Number(process.env.COST_PER_MESSAGE_MARKETING || fallback);
    return Number.isFinite(v) ? v : fallback;
  }
  if (c === "authentication") {
    const v = Number(process.env.COST_PER_MESSAGE_AUTHENTICATION || fallback);
    return Number.isFinite(v) ? v : fallback;
  }
  if (c === "utility") {
    const v = Number(process.env.COST_PER_MESSAGE_UTILITY || fallback);
    return Number.isFinite(v) ? v : fallback;
  }

  return fallback;
}

async function getOrCreateWallet(workspaceId) {
  return Wallet.findOneAndUpdate(
    { workspaceId },
    { $setOnInsert: { workspaceId, balance: Number.isFinite(SEED_BALANCE) ? SEED_BALANCE : 0, currency: "INR" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function ensureBalance(workspaceId, amount) {
  const wallet = await getOrCreateWallet(workspaceId);
  const currentBalance = roundCurrency(wallet.balance);
  const required = roundCurrency(amount);
  if (currentBalance + 1e-9 < required) {
    throw new HttpError(402, "Insufficient wallet balance", {
      balance: currentBalance,
      required,
    });
  }
  return wallet;
}

async function debit(workspaceId, amount, reason, meta = {}) {
  const normalizedAmount = roundCurrency(amount);
  if (normalizedAmount <= 0) return getOrCreateWallet(workspaceId);
  await getOrCreateWallet(workspaceId);

  const wallet = await Wallet.findOneAndUpdate(
    { workspaceId, balance: { $gte: normalizedAmount } },
    { $inc: { balance: -normalizedAmount } },
    { returnDocument: "after" }
  );
  if (!wallet) {
    throw new HttpError(402, "Insufficient wallet balance");
  }

  await Transaction.create({
    workspaceId,
    type: "debit",
    amount: normalizedAmount,
    currency: wallet.currency,
    reason,
    provider: "internal",
    meta,
  });

  return wallet;
}

async function credit(workspaceId, amount, reason, provider = "internal", providerRef = "", meta = {}) {
  const normalizedAmount = roundCurrency(amount);
  if (normalizedAmount <= 0) throw new HttpError(400, "Invalid amount");
  await getOrCreateWallet(workspaceId);
  const wallet = await Wallet.findOneAndUpdate(
    { workspaceId },
    { $inc: { balance: normalizedAmount } },
    { returnDocument: "after" }
  );

  await Transaction.create({
    workspaceId,
    type: "credit",
    amount: normalizedAmount,
    currency: wallet.currency,
    reason,
    provider,
    providerRef,
    meta,
  });

  return wallet;
}

async function chargeForMessaging(payerWorkspaceId, amount, reason, meta = {}) {
  if (!walletChargesEnabled()) {
    return { charged: false, amount: 0, merchantCredited: false, wallet: await getOrCreateWallet(payerWorkspaceId) };
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    return { charged: false, amount: 0, merchantCredited: false, wallet: await getOrCreateWallet(payerWorkspaceId) };
  }

  const wallet = await debit(payerWorkspaceId, Number(amount), reason, meta);

  let merchantCredited = false;
  if (MERCHANT_WORKSPACE_ID && mongoose.Types.ObjectId.isValid(MERCHANT_WORKSPACE_ID)) {
    try {
      await credit(
        MERCHANT_WORKSPACE_ID,
        Number(amount),
        "Message revenue",
        "internal",
        String(payerWorkspaceId),
        { ...meta, fromWorkspaceId: String(payerWorkspaceId) }
      );
      merchantCredited = true;
    } catch (err) {
      // Best-effort; don't block sends if merchant credit fails.
    }
  }

  return { charged: true, amount: Number(amount), merchantCredited, wallet };
}

async function refundMessagingCharge(payerWorkspaceId, amount, meta = {}) {
  if (!walletChargesEnabled()) return { refunded: false };
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return { refunded: false };

  await credit(payerWorkspaceId, Number(amount), "Message refund (send failed)", "internal", "", meta);

  if (MERCHANT_WORKSPACE_ID && mongoose.Types.ObjectId.isValid(MERCHANT_WORKSPACE_ID)) {
    try {
      await debit(MERCHANT_WORKSPACE_ID, Number(amount), "Message revenue reversal", meta);
    } catch (err) {
      // Best-effort.
    }
  }

  return { refunded: true };
}

function messageCost(count = 1) {
  const n = Math.max(Number(count || 0), 0);
  return roundCurrency(COST_PER_MESSAGE * n);
}

function messageCostForTemplateCategory(category, count = 1) {
  const n = Math.max(Number(count || 0), 0);
  return roundCurrency(perCategoryCost(category) * n);
}

module.exports = {
  getOrCreateWallet,
  ensureBalance,
  debit,
  credit,
  chargeForMessaging,
  refundMessagingCharge,
  messageCost,
  messageCostForTemplateCategory,
  walletChargesEnabled,
  roundCurrency,
};
