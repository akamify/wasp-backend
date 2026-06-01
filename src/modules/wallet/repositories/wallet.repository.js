const { Wallet } = require("@infra/database/Wallet");
const { Transaction } = require("@infra/database/Transaction");

async function getOrCreateWallet(workspaceId, seedBalance) {
  return Wallet.findOneAndUpdate(
    { workspaceId },
    { $setOnInsert: { workspaceId, balance: Number.isFinite(seedBalance) ? seedBalance : 0, currency: "INR" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  );
}

async function debitWallet(workspaceId, normalizedAmount) {
  return Wallet.findOneAndUpdate(
    { workspaceId, balance: { $gte: normalizedAmount } },
    { $inc: { balance: -normalizedAmount } },
    { returnDocument: "after" }
  );
}

async function creditWallet(workspaceId, normalizedAmount, { markRecharge = false } = {}) {
  return Wallet.findOneAndUpdate(
    { workspaceId },
    { $inc: { balance: normalizedAmount }, ...(markRecharge ? { $set: { lastRechargeAt: new Date() } } : {}) },
    { returnDocument: "after" }
  );
}

async function createTransaction(data) {
  return Transaction.create(data);
}

async function listTransactionsCursor({ workspaceId, limit, cursor }) {
  const query = { workspaceId };
  if (cursor) query._id = { $lt: cursor };
  const items = await Transaction.find(query).sort({ _id: -1 }).limit(limit + 1);
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  return { page, hasMore };
}

module.exports = {
  getOrCreateWallet,
  debitWallet,
  creditWallet,
  createTransaction,
  listTransactionsCursor,
};

