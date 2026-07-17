const { HttpError } = require("@shared/utils/httpError");
const walletCoreService = require("@modules/wallet/services/wallet.core.service");

function isCreditDeductionEnabled() {
  return String(process.env.AI_CREDIT_DEDUCTION_ENABLED || "true").toLowerCase() !== "false";
}

function normalizeCredits(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric);
}

async function ensureAiCredits({ workspaceId, minCredits = 1 }) {
  if (!isCreditDeductionEnabled()) {
    return { enabled: false, checked: false };
  }
  const credits = normalizeCredits(minCredits);
  if (credits <= 0) return { enabled: true, checked: false };
  const wallet = await walletCoreService.ensureBalance(workspaceId, credits);
  return { enabled: true, checked: true, requiredCredits: credits, wallet };
}

async function deductAiCredits({ workspaceId, creditsUsed, meta = {} }) {
  if (!isCreditDeductionEnabled()) {
    return { enabled: false, deducted: false, creditsUsed: 0 };
  }
  const credits = normalizeCredits(creditsUsed);
  if (credits <= 0) return { enabled: true, deducted: false, creditsUsed: 0 };
  try {
    const wallet = await walletCoreService.debit(workspaceId, credits, "AI agent usage", {
      ...meta,
      billingKind: "ai_agent_usage",
    });
    return { enabled: true, deducted: true, creditsUsed: credits, wallet };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(402, error?.message || "Unable to deduct AI credits");
  }
}

module.exports = {
  ensureAiCredits,
  deductAiCredits,
};
