const { subscriptionRepository } = require("@modules/billing/repositories");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");
const { HttpError } = require("@shared/utils/httpError");

async function getWorkspaceEntitlements(workspaceId) {
  const active = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (active) {
    return {
      plan: active.planSlug,
      features: active.snapshot?.features || {},
      limits: active.snapshot?.limits || {},
      subscription: active,
    };
  }
  const free = await getFreePlanConfig();
  return { plan: "free", features: free?.features || {}, limits: free?.limits || {}, subscription: null };
}

async function canWorkspaceUseFeature(workspaceId, featureKey) {
  const entitlements = await getWorkspaceEntitlements(workspaceId);
  return Boolean(entitlements.features?.[featureKey]);
}

async function assertWorkspaceLimit(workspaceId, limitKey, currentUsage) {
  const entitlements = await getWorkspaceEntitlements(workspaceId);
  const limit = Number(entitlements.limits?.[limitKey] ?? 0);
  if (limit > 0 && Number(currentUsage || 0) >= limit) {
    throw new HttpError(403, `Workspace limit reached: ${limitKey}`, { limitKey, limit, currentUsage });
  }
  return { limit, currentUsage: Number(currentUsage || 0), entitlements };
}

module.exports = { assertWorkspaceLimit, canWorkspaceUseFeature, getWorkspaceEntitlements };
