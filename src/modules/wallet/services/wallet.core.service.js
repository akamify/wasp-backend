const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { walletRepository } = require("@modules/wallet/repositories/index");
const {
  SEED_BALANCE,
  MERCHANT_WORKSPACE_ID,
  roundCurrency,
  walletChargesEnabled,
  walletChargesEnabledLive,
  messageCost,
  messageCostForTemplateCategory,
  messageCostForTemplateCategoryLive,
  isMerchantWorkspaceConfigured,
} = require("@modules/wallet/utils/wallet.utils");

async function getOrCreateWallet(workspaceId) {
  return walletRepository.getOrCreateWallet(workspaceId, SEED_BALANCE);
}

async function ensureBalance(workspaceId, amount) {
  const wallet = await getOrCreateWallet(workspaceId);
  const currentBalance = roundCurrency(wallet.balance);
  const availableBalance = roundCurrency(currentBalance - Number(wallet.reservedBalance || 0));
  const required = roundCurrency(amount);
  if (availableBalance + 1e-9 < required) {
    throw new HttpError(402, "Insufficient wallet balance", { balance: currentBalance, availableBalance, required });
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

  const wallet = await walletRepository.creditWallet(workspaceId, normalizedAmount, { markRecharge: provider === "razorpay" });

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
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) return { refunded: false };

  await credit(payerWorkspaceId, Number(amount), "Message refund (send failed)", "internal", "", meta);

  if (isMerchantWorkspaceConfigured()) {
    try {
      await debit(MERCHANT_WORKSPACE_ID, Number(amount), "Message revenue reversal", meta);
    } catch (err) {}
  }

  return { refunded: true };
}

function normalizeTemplateCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  return ["marketing", "utility", "authentication"].includes(normalized) ? normalized : "unknown";
}

async function reserveTemplateCharge(workspaceId, category, meta = {}) {
  const walletChargingEnabled = await walletChargesEnabledLive();
  const normalizedCategory = normalizeTemplateCategory(category);
  const amount = walletChargingEnabled
    ? roundCurrency(await messageCostForTemplateCategoryLive(normalizedCategory, 1))
    : 0;
  if (!walletChargingEnabled || amount <= 0) {
    console.info("[wallet] template charging skipped", {
      workspaceId: String(workspaceId),
      category: normalizedCategory,
      chargeAmount: 0,
      walletChargingDisabled: true,
    });
    return {
      reservationId: null,
      amount: 0,
      category: normalizedCategory,
      platformWalletCharged: false,
      chargeSource: "none",
      walletChargingDisabled: true,
    };
  }

  await getOrCreateWallet(workspaceId);
  const wallet = await walletRepository.reserveWalletFunds(workspaceId, amount);
  if (!wallet) {
    console.warn("[wallet] template charge blocked insufficient balance", {
      workspaceId: String(workspaceId),
      category: normalizedCategory,
      amount,
    });
    throw new HttpError(402, "Insufficient wallet balance. Add credits to send templates.", {
      code: "INSUFFICIENT_WALLET_BALANCE",
      userMessage: "Insufficient wallet balance. Add credits to send templates.",
      required: amount,
    });
  }

  try {
    const reservation = await walletRepository.createReservation({
      workspaceId,
      amount,
      currency: wallet.currency,
      category: normalizedCategory,
      meta,
    });
    return {
      reservationId: reservation._id,
      amount,
      category: normalizedCategory,
      platformWalletCharged: false,
      chargeSource: "wallet",
      walletChargingDisabled: false,
    };
  } catch (error) {
    await walletRepository.releaseWalletFunds(workspaceId, amount).catch(() => {});
    throw error;
  }
}

async function releaseTemplateCharge(workspaceId, reservation) {
  if (!reservation?.reservationId || reservation.amount <= 0) return { released: false };
  const updated = await walletRepository.updateHeldReservation(reservation.reservationId, {
    status: "released",
    releasedAt: new Date(),
  });
  if (!updated) return { released: false };
  await walletRepository.releaseWalletFunds(workspaceId, reservation.amount);
  return { released: true };
}

async function finalizeTemplateCharge(workspaceId, reservation, details = {}) {
  if (!reservation?.reservationId || reservation.amount <= 0) {
    return { charged: false, amount: 0, transaction: null };
  }
  const wallet = await walletRepository.finalizeWalletFunds(workspaceId, reservation.amount);
  if (!wallet) throw new Error("Unable to finalize reserved template wallet charge");
  const transaction = await walletRepository.createTransaction({
    workspaceId,
    type: "template_message_charge",
    amount: reservation.amount,
    currency: wallet.currency,
    reason: "Template message charge",
    provider: "internal",
    providerRef: details.wamid || "",
    meta: {
      ...details,
      category: reservation.category,
      chargeSource: "wallet",
      metaBillingNote: "Meta billing is charged separately through the configured WhatsApp billing hub.",
    },
  });
  await walletRepository.updateHeldReservation(reservation.reservationId, {
    status: "finalized",
    finalizedAt: new Date(),
    messageId: details.messageId || null,
    walletTransactionId: transaction._id,
  });
  console.info("[wallet] template charge finalized", {
    workspaceId: String(workspaceId),
    messageId: details.messageId ? String(details.messageId) : null,
    category: reservation.category,
    amount: reservation.amount,
  });
  return { charged: true, amount: reservation.amount, transaction };
}

module.exports = {
  getOrCreateWallet,
  ensureBalance,
  debit,
  credit,
  chargeForMessaging,
  refundMessagingCharge,
  reserveTemplateCharge,
  releaseTemplateCharge,
  finalizeTemplateCharge,
  messageCost,
  messageCostForTemplateCategory,
  messageCostForTemplateCategoryLive,
  walletChargesEnabled,
  walletChargesEnabledLive,
  roundCurrency,
};

