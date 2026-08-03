const { billingRepository } = require("@modules/billing/repositories");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");
const { HttpError } = require("@shared/utils/httpError");

function normalizeLimitValue(value) {
  return value === null ? null : Number(value ?? 0);
}

function bytesFromMb(value) {
  const mb = Number(value || 0);
  if (!Number.isFinite(mb) || mb <= 0) return 0;
  return Math.round(mb * 1024 * 1024);
}

function buildLimitError({ message, details }) {
  return new HttpError(403, message, {
    code: "WORKSPACE_LIMIT_REACHED",
    ...(details || {}),
  });
}

async function getWorkspaceLimitSnapshot(workspaceId) {
  const entitlements = await getWorkspaceEntitlements(workspaceId);
  return {
    entitlements,
    limits: entitlements?.limits || {},
  };
}

async function assertMediaFileSizeAllowed({ workspaceId, fileSizeBytes }) {
  const { limits } = await getWorkspaceLimitSnapshot(workspaceId);
  const rawLimit = normalizeLimitValue(limits.maxMediaSizeMb);
  if (rawLimit === null) return { limitMb: null, limitBytes: null };

  const limitMb = Math.max(0, Number(rawLimit || 0));
  const limitBytes = bytesFromMb(limitMb);
  if (!limitBytes || Number(fileSizeBytes || 0) > limitBytes) {
    throw buildLimitError({
      message: `Your subscription allows media uploads up to ${limitMb} MB.`,
      details: {
        limitKey: "maxMediaSizeMb",
        limit: limitMb,
        currentUsage: Number((Number(fileSizeBytes || 0) / (1024 * 1024)).toFixed(2)),
        requiredAction: "Upgrade your subscription or upload a smaller file.",
      },
    });
  }

  return { limitMb, limitBytes };
}

async function assertStorageQuotaAvailable({ workspaceId, incomingBytes, excludedBytes = 0 }) {
  const { limits } = await getWorkspaceLimitSnapshot(workspaceId);
  const rawLimit = normalizeLimitValue(limits.maxStorageMb);
  if (rawLimit === null) return { limitMb: null, limitBytes: null, usedBytes: 0, projectedBytes: 0 };

  const limitMb = Math.max(0, Number(rawLimit || 0));
  const limitBytes = bytesFromMb(limitMb);
  const usage = await billingRepository.countWorkspaceUsage(workspaceId);
  const usedBytes = Math.max(0, Number(usage?.storageBytes || 0) - Math.max(0, Number(excludedBytes || 0)));
  const projectedBytes = usedBytes + Math.max(0, Number(incomingBytes || 0));

  if (!limitBytes || projectedBytes > limitBytes) {
    throw buildLimitError({
      message: `Your subscription allows ${limitMb} MB of workspace storage.`,
      details: {
        limitKey: "maxStorageMb",
        limit: limitMb,
        currentUsage: Number((usedBytes / (1024 * 1024)).toFixed(2)),
        projectedUsage: Number((projectedBytes / (1024 * 1024)).toFixed(2)),
        requiredAction: "Upgrade your subscription or delete existing uploaded media and files.",
      },
    });
  }

  return { limitMb, limitBytes, usedBytes, projectedBytes };
}

async function assertDailyOutboundMessageAllowed({ workspaceId, increment = 1 }) {
  const { limits } = await getWorkspaceLimitSnapshot(workspaceId);
  const rawLimit = normalizeLimitValue(limits.dailyMessageLimit);
  if (rawLimit === null) return { limit: null, used: 0, remaining: null };

  const limit = Math.max(0, Number(rawLimit || 0));
  const usage = await billingRepository.countWorkspaceUsage(workspaceId);
  const used = Number(usage?.outboundMessagesTodayCount || 0);
  const projected = used + Math.max(1, Number(increment || 1));

  if (!limit || projected > limit) {
    throw buildLimitError({
      message: `Your subscription allows a maximum of ${limit.toLocaleString("en-IN")} outbound messages per day.`,
      details: {
        limitKey: "dailyMessageLimit",
        limit,
        currentUsage: used,
        projectedUsage: projected,
        requiredAction: "Upgrade your subscription or wait until the daily limit resets.",
      },
    });
  }

  return {
    limit,
    used,
    remaining: Math.max(0, limit - projected),
  };
}

module.exports = {
  assertDailyOutboundMessageAllowed,
  assertMediaFileSizeAllowed,
  assertStorageQuotaAvailable,
  bytesFromMb,
  getWorkspaceLimitSnapshot,
};
