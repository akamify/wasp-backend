const { subscriptionRepository } = require("@modules/billing/repositories");
const { HttpError } = require("@shared/utils/httpError");

const FREE_LIMITS = Object.freeze({
  maxContacts: 10,
  maxTemplates: 5,
  maxCampaignsPerMonth: 3,
  maxContactsExport: 10,
  maxExportsPerMonth: 10,
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

async function enforceMonthlyLimit({
  workspaceId,
  limitKey,
  limitKeys,
  errorMessage,
  countInWindow,
}) {
  const subscription = await subscriptionRepository.findActiveByWorkspace(workspaceId);
  if (!subscription) {
    const keys = Array.isArray(limitKeys) && limitKeys.length
      ? limitKeys
      : [limitKey].filter(Boolean);
    const selectedKey = keys.find((k) => FREE_LIMITS[k] !== undefined) || keys[0];
    const limitNumber = Number(FREE_LIMITS[selectedKey] ?? 0);
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
  enforceMonthlyLimit,
  resolveCycleWindow,
  FREE_LIMITS,
};
