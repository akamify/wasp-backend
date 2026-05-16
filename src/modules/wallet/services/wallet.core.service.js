const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { walletRepository } = require("@modules/wallet/repositories/index");
const {
  SEED_BALANCE,
  MERCHANT_WORKSPACE_ID,
  roundCurrency,
  walletChargesEnabled,
  messageCost,
  messageCostForTemplateCategory,
  isMerchantWorkspaceConfigured,
} = require("@modules/wallet/utils/wallet.utils");

async function getOrCreateWallet(workspaceId) {
  return walletRepository.getOrCreateWallet(workspaceId, SEED_BALANCE);
}

async function ensureBalance(workspaceId, amount) {
  const wallet = await getOrCreateWallet(workspaceId);
  const currentBalance = roundCurrency(wallet.balance);
  const required = roundCurrency(amount);
  if (currentBalance + 1e-9 < required) {
    throw new HttpError(402, "Insufficient wallet balance", { balance: currentBalance, required });
  }
  return wallet;
}

async function debit(workspaceId, amount, reason, meta = {}) {
  const normalizedAmount = roundCurrency(amount);
  if (normalizedAmount <= 0) return getOrCreateWallet(workspaceId);
  await getOrCreateWallet(workspaceId);

  const wallet = await walletRepository.debitWallet(workspaceId, normalizedAmount);
  if (!wallet) throw new HttpError(402, "Insufficient wallet balance");

  await walletRepository.createTransaction({
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

  const wallet = await walletRepository.creditWallet(workspaceId, normalizedAmount);

  await walletRepository.createTransaction({
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
  if (isMerchantWorkspaceConfigured()) {
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
    } catch (err) {}
  }

  return { charged: true, amount: Number(amount), merchantCredited, wallet };
}

async function refundMessagingCharge(payerWorkspaceId, amount, meta = {}) {
  if (!walletChargesEnabled()) return { refunded: false };
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return { refunded: false };

  await credit(payerWorkspaceId, Number(amount), "Message refund (send failed)", "internal", "", meta);

  if (isMerchantWorkspaceConfigured()) {
    try {
      await debit(MERCHANT_WORKSPACE_ID, Number(amount), "Message revenue reversal", meta);
    } catch (err) {}
  }

  return { refunded: true };
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

