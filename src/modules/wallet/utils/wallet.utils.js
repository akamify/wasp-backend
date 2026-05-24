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

function messageCost(count = 1) {
  const n = Math.max(Number(count || 0), 0);
  return roundCurrency(COST_PER_MESSAGE * n);
}

function messageCostForTemplateCategory(category, count = 1) {
  const n = Math.max(Number(count || 0), 0);
  return roundCurrency(perCategoryCost(category) * n);
}

function isMerchantWorkspaceConfigured() {
  return MERCHANT_WORKSPACE_ID && mongoose.Types.ObjectId.isValid(MERCHANT_WORKSPACE_ID);
}

module.exports = {
  COST_PER_MESSAGE,
  SEED_BALANCE,
  MERCHANT_WORKSPACE_ID,
  roundCurrency,
  walletChargesEnabled,
  perCategoryCost,
  messageCost,
  messageCostForTemplateCategory,
  isMerchantWorkspaceConfigured,
};

