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

function walletChargesEnabled() {
  return String(process.env.WALLET_CHARGES_ENABLED || "").trim().toLowerCase() === "true";
}

async function walletChargesEnabledLive() {
  return walletChargesEnabled();
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

async function messageCostForTemplateCategoryLive(category, count = 1) {
  const c = String(category || "").trim().toLowerCase();
  const n = Math.max(Number(count || 0), 0);
  const fallback = perCategoryCost(c);
  const keyByCategory = {
    marketing: "COST_PER_MESSAGE_MARKETING",
    utility: "COST_PER_MESSAGE_UTILITY",
    authentication: "COST_PER_MESSAGE_AUTHENTICATION",
  };

  try {
    const {
      getSettingNumber,
      getSettingWithMeta,
    } = require("@modules/platform-settings/services/platformSettingsResolver.service");
    const genericCost = await getSettingNumber("COST_PER_MESSAGE", COST_PER_MESSAGE);
    let cost = genericCost;
    if (keyByCategory[c]) {
      const specific = await getSettingWithMeta(keyByCategory[c]);
      const specificCost = Number(specific.value);
      cost = Number.isFinite(specificCost) ? specificCost : genericCost;
    }
    if (!Number.isFinite(cost)) cost = fallback;
    return roundCurrency(cost * n);
  } catch {
    return roundCurrency(fallback * n);
  }
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
  walletChargesEnabledLive,
  perCategoryCost,
  messageCost,
  messageCostForTemplateCategory,
  messageCostForTemplateCategoryLive,
  isMerchantWorkspaceConfigured,
};

