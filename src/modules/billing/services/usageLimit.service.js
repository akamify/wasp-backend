const { subscriptionRepository } = require("@modules/billing/repositories");
const { HttpError } = require("@shared/utils/httpError");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");
const { contactsRepository } = require("@modules/contacts/repositories");
const { templatesRepository } = require("@modules/templates/repositories");
const apiKeyRepository = require("@modules/api-keys/repositories/apiKey.repository");
const flowsRepository = require("@modules/flows/repositories/flows.repository");
const { ExternalChatWebhook } = require("@infra/database/ExternalChatWebhook");

const RESOURCE_LIMIT_DEFINITIONS = Object.freeze({
  contacts: {
    label: "contacts",
    limitKeys: ["maxContacts"],
    resolveUsage: ({ workspaceId }) => contactsRepository.countStoredContacts({ workspaceId }),
    upgradeMessage: "Please upgrade your subscription or delete existing contacts.",
  },
  templates: {
    label: "templates",
    limitKeys: ["maxTemplates"],
    resolveUsage: ({ workspaceId }) => templatesRepository.countStoredTemplates({ workspaceId }),
    upgradeMessage: "Please upgrade your subscription or delete existing templates.",
  },
  apikeys: {
    label: "API keys",
    limitKeys: ["maxApiKeys"],
    resolveUsage: ({ workspaceId }) => apiKeyRepository.countWorkspaceActiveApiKeys(workspaceId),
    upgradeMessage: "Please upgrade your subscription or delete an existing API key.",
  },
  webhooks: {
    label: "webhooks",
    limitKeys: ["maxWebhooks"],
    resolveUsage: ({ workspaceId }) => ExternalChatWebhook.countDocuments({ workspaceId }),
    upgradeMessage: "Please upgrade your subscription or delete an existing webhook.",
  },
  flows: {
    label: "flows",
    limitKeys: ["maxFlows"],
    resolveUsage: ({ workspaceId }) => flowsRepository.countStoredFlows({ workspaceId }),
    upgradeMessage: "Please upgrade your subscription or archive existing flows.",
  },
});

function addMonths(date, months) {
  const d = new Date(date);
  const dayOfMonth = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < dayOfMonth) d.setDate(0);
  return d;
}

function resolveCycleWindow(subscription, now = new Date()) {
  const periodStart = subscription?.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null;
  if (!periodStart || Number.isNaN(periodStart.getTime())) return null;

  const durationMonths = Math.max(1, Number(subscription?.durationMonths || 1));
  for (let i = 0; i < durationMonths; i += 1) {
    const start = addMonths(periodStart, i);
    const end = addMonths(periodStart, i + 1);
    if (now >= start && now < end) return { start, end, monthIndex: i + 1, durationMonths };
  }

  const lastStart = addMonths(periodStart, durationMonths - 1);
  const lastEnd = addMonths(periodStart, durationMonths);
  return { start: lastStart, end: lastEnd, monthIndex: durationMonths, durationMonths };
}

function resolveResourceDefinition(resourceKey) {
  const key = String(resourceKey || "").trim().toLowerCase();
  const definition = RESOURCE_LIMIT_DEFINITIONS[key];
  if (!definition) {
    throw new HttpError(500, `Unknown usage limit resource: ${resourceKey}`);
  }
  return definition;
}

function resolveLimitSnapshot(entitlements = {}, limitKeys = []) {
  const keys = Array.isArray(limitKeys) && limitKeys.length ? limitKeys : [];
  const selectedKey = keys.find((key) => entitlements?.limits?.[key] !== undefined) || keys[0];
  return {
    selectedKey,
    limitValue: selectedKey ? entitlements?.limits?.[selectedKey] : undefined,
  };
}

function buildStoredLimitError({ label, limit, upgradeMessage, limitKey, currentUsage }) {
  return new HttpError(
    403,
    `Your current subscription allows a maximum of ${Number(limit || 0).toLocaleString("en-IN")} ${label}. ${upgradeMessage}`,
    {
      code: "WORKSPACE_LIMIT_REACHED",
      limitKey,
      limit,
      currentUsage,
      resource: label,
    }
  );
}

async function getUsageState({ workspaceId, resourceKey, currentUsage } = {}) {
  const definition = resolveResourceDefinition(resourceKey);
  const entitlements = await getWorkspaceEntitlements(workspaceId);
  const { selectedKey, limitValue } = resolveLimitSnapshot(entitlements, definition.limitKeys);
  const usage = currentUsage == null ? await definition.resolveUsage({ workspaceId }) : Number(currentUsage || 0);

  if (limitValue === null) {
    return {
      resourceKey,
      label: definition.label,
      limitKey: selectedKey,
      currentUsage: usage,
      limit: null,
      remaining: null,
      unlimited: true,
      allowed: true,
      entitlements,
    };
  }

  const limit = Number(limitValue ?? 0);
  const remaining = limit > 0 ? Math.max(0, limit - usage) : 0;
  return {
    resourceKey,
    label: definition.label,
    limitKey: selectedKey,
    currentUsage: usage,
    limit,
    remaining,
    unlimited: false,
    allowed: Number.isFinite(limit) && limit > usage && limit > 0,
    blocked: !Number.isFinite(limit) || limit <= 0,
    entitlements,
    upgradeMessage: definition.upgradeMessage,
  };
}

async function checkLimit(workspaceId, resourceKey, options = {}) {
  const state = await getUsageState({ workspaceId, resourceKey, currentUsage: options.currentUsage });
  if (state.unlimited) return state;
  if (state.blocked) {
    throw buildStoredLimitError({
      label: state.label,
      limit: state.limit,
      upgradeMessage: state.upgradeMessage,
      limitKey: state.limitKey,
      currentUsage: state.currentUsage,
    });
  }
  if (state.currentUsage >= state.limit) {
    throw buildStoredLimitError({
      label: state.label,
      limit: state.limit,
      upgradeMessage: state.upgradeMessage,
      limitKey: state.limitKey,
      currentUsage: state.currentUsage,
    });
  }
  return state;
}

async function enforceMonthlyLimit({
  workspaceId,
  limitKey,
  limitKeys,
  errorMessage,
  countInWindow,
}) {
  if (!isPlanRestrictionsEnabled()) {
    return { enforced: false, reason: "plan_restrictions_disabled" };
  }
  const subscription = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!subscription) {
    const freeConfig = await getFreePlanConfig();
    const freeLimits = freeConfig?.limits || {};
    const keys = Array.isArray(limitKeys) && limitKeys.length
      ? limitKeys
      : [limitKey].filter(Boolean);
    const selectedKey = keys.find((k) => freeLimits[k] !== undefined) || keys[0];
    const limitNumber = Number(freeLimits[selectedKey] ?? 0);
    if (!Number.isFinite(limitNumber) || limitNumber <= 0) {
      throw new HttpError(403, errorMessage || "Your current plan does not allow this action");
    }

    const now = new Date();
    const windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const windowEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const used = await countInWindow(windowStart, windowEnd);
    if (used >= limitNumber) {
      throw new HttpError(403, errorMessage || "Monthly plan limit reached", {
        limitKey: selectedKey || limitKey,
        limit: limitNumber,
        used,
        cycleMonth: 1,
        cycleMonths: 1,
        windowStart,
        windowEnd,
      });
    }

    return {
      enforced: true,
      limit: limitNumber,
      used,
      remaining: Math.max(0, limitNumber - used),
      window: { start: windowStart, end: windowEnd, monthIndex: 1, durationMonths: 1 },
      reason: "free_plan",
    };
  }

  const keys = Array.isArray(limitKeys) && limitKeys.length
    ? limitKeys
    : [limitKey].filter(Boolean);
  const selectedKey = keys.find((k) => subscription?.snapshot?.limits?.[k] !== undefined) || keys[0];
  const limitValue = selectedKey ? subscription?.snapshot?.limits?.[selectedKey] : undefined;
  if (limitValue === null) return { enforced: false, reason: "unlimited" };

  const limitNumber = Number(limitValue);
  if (!Number.isFinite(limitNumber) || limitNumber <= 0) {
    throw new HttpError(403, errorMessage || "Your current plan does not allow this action");
  }

  const window = resolveCycleWindow(subscription);
  if (!window) return { enforced: false, reason: "window_unavailable" };

  const used = await countInWindow(window.start, window.end);
  if (used >= limitNumber) {
    throw new HttpError(403, errorMessage || "Monthly plan limit reached", {
      limitKey: selectedKey || limitKey,
      limit: limitNumber,
      used,
      cycleMonth: window.monthIndex,
      cycleMonths: window.durationMonths,
      windowStart: window.start,
      windowEnd: window.end,
    });
  }

  return {
    enforced: true,
    limit: limitNumber,
    used,
    remaining: Math.max(0, limitNumber - used),
    window,
  };
}

module.exports = {
  checkLimit,
  enforceMonthlyLimit,
  getUsageState,
  resolveCycleWindow,
};
