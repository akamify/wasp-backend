const { subscriptionRepository, billingRepository } = require("@modules/billing/repositories");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");

function normalizeLimits(raw = {}) {
  return {
    maxContacts: raw.maxContacts ?? 0,
    maxTemplates: raw.maxTemplates ?? 0,
    maxEmployees: raw.maxEmployees ?? 0,
    maxCampaignsPerMonth: raw.maxCampaignsPerMonth ?? 0,
  };
}

function usageMetric(used, limit) {
  if (limit === null || limit === undefined) return { used, limit: null, remaining: null, percent: 0 };
  const max = Math.max(0, Number(limit || 0));
  const remaining = Math.max(0, max - used);
  const percent = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { used, limit: max, remaining, percent };
}

async function currentSubscription(req) {
  const active = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
  const usageCounts = await billingRepository.countWorkspaceUsage(req.workspace.id);
  if (!active) {
    const freeConfig = await getFreePlanConfig();
    const freeLimits = {
      maxContacts: freeConfig?.limits?.maxContacts ?? 0,
      maxTemplates: freeConfig?.limits?.maxTemplates ?? 0,
      maxEmployees: 0,
      maxCampaignsPerMonth: freeConfig?.limits?.maxCampaignsPerMonth ?? 0,
      maxContactsExport: freeConfig?.limits?.maxContactsExport ?? 0,
    };
    return {
      success: true,
      subscription: null,
      effective: {
        plan: req.workspace?.plan || "free",
        features: {
          ...(freeConfig?.features || {}),
        },
        limits: freeLimits,
      },
      usage: {
        contacts: usageMetric(usageCounts.contactsCount, freeLimits.maxContacts),
        templates: usageMetric(usageCounts.templatesCount, freeLimits.maxTemplates),
        employees: usageMetric(usageCounts.employeesCount, 0),
        campaigns: usageMetric(usageCounts.campaignsCount, freeLimits.maxCampaignsPerMonth),
      },
    };
  }

  const limits = normalizeLimits(active?.snapshot?.limits || {});

  return {
    success: true,
    subscription: {
      id: String(active._id),
      planSlug: active.planSlug,
      planName: active.planName,
      planType: active.planType,
      status: active.status,
      currentPeriodStart: active.currentPeriodStart,
      currentPeriodEnd: active.currentPeriodEnd,
      autoRenewEnabled: Boolean(active.autoRenewEnabled),
      cancelAtPeriodEnd: Boolean(active.cancelAtPeriodEnd),
      features: active?.snapshot?.features || {},
      limits: limits,
    },
    effective: {
      plan: active.planSlug,
      features: active?.snapshot?.features || {},
      limits: limits,
    },
    usage: {
      contacts: usageMetric(usageCounts.contactsCount, limits.maxContacts),
      templates: usageMetric(usageCounts.templatesCount, limits.maxTemplates),
      employees: usageMetric(usageCounts.employeesCount, limits.maxEmployees),
      campaigns: usageMetric(usageCounts.campaignsCount, limits.maxCampaignsPerMonth),
    },
  };
}

async function subscriptionHistory(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 20) || 20;
  const limit = Math.min(Math.max(limitRaw, 5), 50);
  const skip = (page - 1) * limit;
  const q = String(req.query.q || "").trim();

  const [rows, total] = await Promise.all([
    subscriptionRepository.listByWorkspace(req.workspace.id, { skip, limit, query: q || null }),
    subscriptionRepository.countByWorkspace(req.workspace.id, { query: q || null }),
  ]);

  const items = rows.map((s) => ({
    id: String(s._id),
    planName: s.planName || "",
    planSlug: s.planSlug || "",
    status: s.status || "",
    paymentType: s.paymentMode || "",
    transactionId:
      s.snapshot?.price?.transactionId ||
      s.snapshot?.price?.paymentId ||
      s.snapshot?.price?.providerRef ||
      s.razorpaySubscriptionId ||
      "",
    validFrom: s.currentPeriodStart || null,
    validUntil: s.currentPeriodEnd || null,
    createdAt: s.createdAt || null,
    durationMonths: Number(s.durationMonths || 1),
    amountPaidPaise: Number(s.snapshot?.price?.discountedPricePaise || 0),
    gstAmountPaise: Number(s.snapshot?.gst?.gstAmountPaise || 0),
    payableAmountPaise: Number(s.snapshot?.price?.payableAmountPaise || 0),
    autoRenewEnabled: Boolean(s.autoRenewEnabled),
    features: s.snapshot?.features || {},
    limits: s.snapshot?.limits || {},
  }));

  return {
    success: true,
    message: "Subscription history fetched.",
    data: {
      items,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    },
  };
}

module.exports = { currentSubscription, subscriptionHistory };
