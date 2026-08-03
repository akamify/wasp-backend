const { HttpError } = require("@shared/utils/httpError");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");
const { AiCreditTransaction } = require("@infra/database/AiCreditTransaction");

function isCreditDeductionEnabled() {
  return String(process.env.AI_CREDIT_DEDUCTION_ENABLED || "true").toLowerCase() !== "false";
}

function normalizeCredits(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric);
}

async function ensureAiCredits({ workspaceId, minCredits = 1, executionKey = null }) {
  if (!isCreditDeductionEnabled()) {
    return { enabled: false, checked: false };
  }
  const credits = normalizeCredits(minCredits);
  if (credits <= 0) return { enabled: true, checked: false };
  const normalizedExecutionKey = String(executionKey || "").trim();
  if (normalizedExecutionKey) {
    const priorUsage = await AiCreditTransaction.findOne({
      workspaceId,
      type: "usage",
      direction: "debit",
      executionKey: normalizedExecutionKey,
    })
      .select("_id credits balanceAfter")
      .lean();
    if (priorUsage?._id) {
      return {
        enabled: true,
        checked: false,
        alreadyDeducted: true,
        requiredCredits: credits,
        remainingCredits: Number(priorUsage.balanceAfter?.remainingCredits || 0),
        remainingTokens: Number(priorUsage.balanceAfter?.remainingTokens || 0),
      };
    }
  }
  const status = await aiAddonService.getAddonStatus({ workspaceId });
  if (!status?.access?.enabled) {
    throw new HttpError(403, "AI Agent add-on is not active for this workspace.", {
      code: "AI_ADDON_REQUIRED",
    });
  }
  if (Number(status.workspace?.remainingCredits || 0) < credits) {
    throw new HttpError(402, "AI credits exhausted. Renew or top up your AI add-on.");
  }
  return {
    enabled: true,
    checked: true,
    alreadyDeducted: false,
    requiredCredits: credits,
    remainingCredits: Number(status.workspace?.remainingCredits || 0),
    remainingTokens: Number(status.workspace?.remainingTokens || 0),
    currency: status.subscription?.currency || "INR",
  };
}

async function deductAiCredits({ workspaceId, creditsUsed, meta = {} }) {
  if (!isCreditDeductionEnabled()) {
    return { enabled: false, deducted: false, creditsUsed: 0 };
  }
  const credits = normalizeCredits(creditsUsed);
  if (credits <= 0) return { enabled: true, deducted: false, creditsUsed: 0 };
  try {
    return await aiAddonService.consumeIncludedCredits({
      workspaceId,
      creditsUsed: credits,
      meta: {
        ...meta,
        billingKind: "ai_agent_usage",
      },
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(402, error?.message || "Unable to deduct AI credits");
  }
}

module.exports = {
  ensureAiCredits,
  deductAiCredits,
};
