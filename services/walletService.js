const { Wallet } = require("../models/Wallet");
const { Transaction } = require("../models/Transaction");
const { HttpError } = require("../utils/httpError");

const COST_PER_MESSAGE = Number(process.env.COST_PER_MESSAGE || 1); // INR
const SEED_BALANCE = Number(process.env.WALLET_SEED_BALANCE || 0);

async function getOrCreateWallet(workspaceId) {
  return Wallet.findOneAndUpdate(
    { workspaceId },
    { $setOnInsert: { workspaceId, balance: Number.isFinite(SEED_BALANCE) ? SEED_BALANCE : 0, currency: "INR" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function ensureBalance(workspaceId, amount) {
  const wallet = await getOrCreateWallet(workspaceId);
  if (wallet.balance < amount) {
    throw new HttpError(402, "Insufficient wallet balance", {
      balance: wallet.balance,
      required: amount,
    });
  }
  return wallet;
}

async function debit(workspaceId, amount, reason, meta = {}) {
  if (amount <= 0) return getOrCreateWallet(workspaceId);
  await getOrCreateWallet(workspaceId);

  const wallet = await Wallet.findOneAndUpdate(
    { workspaceId, balance: { $gte: amount } },
    { $inc: { balance: -Number(amount) } },
    { returnDocument: "after" }
  );
  if (!wallet) {
    throw new HttpError(402, "Insufficient wallet balance");
  }

  await Transaction.create({
    workspaceId,
    type: "debit",
    amount,
    currency: wallet.currency,
    reason,
    provider: "internal",
    meta,
  });

  return wallet;
}

async function credit(workspaceId, amount, reason, provider = "internal", providerRef = "", meta = {}) {
  if (amount <= 0) throw new HttpError(400, "Invalid amount");
  await getOrCreateWallet(workspaceId);
  const wallet = await Wallet.findOneAndUpdate(
    { workspaceId },
    { $inc: { balance: Number(amount) } },
    { returnDocument: "after" }
  );

  await Transaction.create({
    workspaceId,
    type: "credit",
    amount,
    currency: wallet.currency,
    reason,
    provider,
    providerRef,
    meta,
  });

  return wallet;
}

function messageCost(count = 1) {
  const n = Math.max(Number(count || 1), 1);
  return COST_PER_MESSAGE * n;
}

module.exports = { getOrCreateWallet, ensureBalance, debit, credit, messageCost };
