const { subscriptionRepository, billingRepository, invoiceRepository } = require("@modules/billing/repositories");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");

function normalizeLimits(raw = {}) {
  const pick = (value, fallback = 0) => (value === null ? null : (value === undefined ? fallback : value));
  return {
    maxContacts: pick(raw.maxContacts),
    maxTemplates: pick(raw.maxTemplates),
    maxEmployees: pick(raw.maxAgents, raw.maxEmployees ?? 0),
    maxAgents: pick(raw.maxAgents, raw.maxEmployees ?? 0),
    maxApiKeys: pick(raw.maxApiKeys),
    maxCampaignsPerMonth: pick(raw.maxCampaignsPerMonth),
    maxContactsExport: pick(raw.maxContactsExport, raw.maxExportsPerMonth ?? 0),
    maxTags: pick(raw.maxTags),
    maxCustomAttributes: pick(raw.maxCustomAttributes),
    maxStorageMb: pick(raw.maxStorageMb),
    maxWebhooks: pick(raw.maxWebhooks),
    messageRatePerSec: pick(raw.messageRatePerSec),
    maxFlows: pick(raw.maxFlows),
    maxMediaSizeMb: pick(raw.maxMediaSizeMb),
    dailyMessageLimit: pick(raw.dailyMessageLimit),
  };
}

function pickLimit(value, fallback = 0) {
  return value === null ? null : (value === undefined ? fallback : value);
}

function usageMetric(used, limit) {
  if (limit === null || limit === undefined) return { used, limit: null, remaining: null, percent: 0 };
  const max = Math.max(0, Number(limit || 0));
  const remaining = Math.max(0, max - used);
  const percent = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { used, limit: max, remaining, percent };
}

async function currentSubscription(req) {
  const planRestrictionsEnabled = isPlanRestrictionsEnabled();
  const active = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
  const paymentDue = await subscriptionRepository.findPaymentDueByWorkspace(req.workspace.id);
  const renewalInvoice = paymentDue?.renewalInvoiceId ? await invoiceRepository.findById(paymentDue.renewalInvoiceId) : null;
  const usageCounts = await billingRepository.countWorkspaceUsage(req.workspace.id);
  if (!active) {
    const freeConfig = await getFreePlanConfig();
    const freeLimits = {
      maxContacts: pickLimit(freeConfig?.limits?.maxContacts, 0),
      maxTemplates: pickLimit(freeConfig?.limits?.maxTemplates, 0),
      maxEmployees: pickLimit(freeConfig?.limits?.maxAgents, 0),
      maxAgents: pickLimit(freeConfig?.limits?.maxAgents, 0),
      maxApiKeys: pickLimit(freeConfig?.limits?.maxApiKeys, 0),
      maxCampaignsPerMonth: pickLimit(freeConfig?.limits?.maxCampaignsPerMonth, 0),
      maxContactsExport: pickLimit(freeConfig?.limits?.maxContactsExport, 0),
      maxTags: pickLimit(freeConfig?.limits?.maxTags, 10),
      maxCustomAttributes: pickLimit(freeConfig?.limits?.maxCustomAttributes, 5),
      maxStorageMb: pickLimit(freeConfig?.limits?.maxStorageMb, 0),
      maxWebhooks: pickLimit(freeConfig?.limits?.maxWebhooks, 0),
      messageRatePerSec: pickLimit(freeConfig?.limits?.messageRatePerSec, 5),
      maxFlows: pickLimit(freeConfig?.limits?.maxFlows, 0),
      maxMediaSizeMb: pickLimit(freeConfig?.limits?.maxMediaSizeMb, 0),
      dailyMessageLimit: pickLimit(freeConfig?.limits?.dailyMessageLimit, 0),
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
      enforcement: {
        planRestrictionsEnabled,
      },
      usage: {
        contacts: usageMetric(usageCounts.contactsCount, freeLimits.maxContacts),
        templates: usageMetric(usageCounts.templatesCount, freeLimits.maxTemplates),
        employees: usageMetric(usageCounts.employeesCount, freeLimits.maxAgents),
        campaigns: usageMetric(usageCounts.campaignsCount, freeLimits.maxCampaignsPerMonth),
        apiKeys: usageMetric(usageCounts.apiKeysCount, freeLimits.maxApiKeys),
        webhooks: usageMetric(usageCounts.webhooksCount, freeLimits.maxWebhooks),
        flows: usageMetric(usageCounts.flowsCount, freeLimits.maxFlows),
        storage: usageMetric(Number(((usageCounts.storageBytes || 0) / (1024 * 1024)).toFixed(2)), freeLimits.maxStorageMb),
        dailyMessages: usageMetric(usageCounts.outboundMessagesTodayCount, freeLimits.dailyMessageLimit),
      },
    };
  }

  const limits = normalizeLimits(active?.snapshot?.limits || {});
  const hasPendingMandateSetup = Boolean(active?.metadata?.pendingMandateSetup?.razorpaySubscriptionId);
  const autoRenewEligible = active.planSlug !== "free" && ["active", "past_due", "grace_period"].includes(String(active.status || ""));
  const fallbackMode = hasPendingMandateSetup ? "pending_mandate" : active.autoRenewEnabled ? "none" : active.planSlug !== "free" ? "manual_renew" : "";

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
      autoRenewEligible,
      autoRenewEnabled: Boolean(active.autoRenewEnabled),
      renewalMethod: active.renewalMethod || "",
      renewalStatus: active.renewalStatus || "",
      renewalAttempts: Number(active.renewalAttempts || 0),
      nextRenewalDate: active.nextBillingAt || active.currentPeriodEnd || null,
      lastRenewalDate: active.lastRenewalAt || null,
      lastRenewalAttemptAt: active.lastRenewalAttemptAt || null,
      nextRenewalAttemptAt: active.nextRenewalAttemptAt || null,
      mandateStatus: active.mandateStatus || "not_setup",
      fallbackMode,
      paymentMethod: active.paymentMethodSnapshot || null,
      pendingMandateSetup: active.metadata?.pendingMandateSetup
        ? {
            razorpaySubscriptionId: active.metadata.pendingMandateSetup.razorpaySubscriptionId || "",
            replaceExisting: Boolean(active.metadata.pendingMandateSetup.replaceExisting),
            createdAt: active.metadata.pendingMandateSetup.createdAt || null,
            providerStatus: active.metadata.pendingMandateSetup.providerStatus || "",
          }
        : null,
      cancelAtPeriodEnd: Boolean(active.cancelAtPeriodEnd),
      scheduledChange: active.scheduledChange?.planId
        ? {
            type: active.scheduledChange.type,
            planId: String(active.scheduledChange.planId),
            planSlug: active.scheduledChange.planSlug,
            planName: active.scheduledChange.planName,
            effectiveAt: active.scheduledChange.effectiveAt,
            requestedAt: active.scheduledChange.requestedAt,
          }
        : null,
      features: active?.snapshot?.features || {},
      limits: limits,
    },
    renewal: paymentDue
      ? {
          status: "payment_due",
          gracePeriodEndsAt: active?.gracePeriodEndsAt || paymentDue.gracePeriodEndsAt || null,
          paymentDueAt: active?.paymentDueAt || paymentDue.paymentDueAt || null,
          targetPlan: {
            id: String(paymentDue.planId),
            slug: paymentDue.planSlug,
            name: paymentDue.planName,
          },
          invoice: renewalInvoice
            ? {
                id: String(renewalInvoice._id),
                invoiceNumber: renewalInvoice.invoiceNumber,
                status: renewalInvoice.status,
                paymentStatus: renewalInvoice.paymentStatus,
                dueDate: renewalInvoice.dueDate,
                totalPaise: Number(renewalInvoice.amounts?.totalPaise || 0),
                currency: renewalInvoice.amounts?.currency || "INR",
              }
            : null,
        }
      : null,
    effective: {
      plan: active.planSlug,
      features: active?.snapshot?.features || {},
      limits: limits,
    },
    enforcement: {
      planRestrictionsEnabled,
    },
    usage: {
      contacts: usageMetric(usageCounts.contactsCount, limits.maxContacts),
      templates: usageMetric(usageCounts.templatesCount, limits.maxTemplates),
      employees: usageMetric(usageCounts.employeesCount, limits.maxAgents ?? limits.maxEmployees),
      campaigns: usageMetric(usageCounts.campaignsCount, limits.maxCampaignsPerMonth),
      apiKeys: usageMetric(usageCounts.apiKeysCount, limits.maxApiKeys),
      webhooks: usageMetric(usageCounts.webhooksCount, limits.maxWebhooks),
      flows: usageMetric(usageCounts.flowsCount, limits.maxFlows),
      storage: usageMetric(Number(((usageCounts.storageBytes || 0) / (1024 * 1024)).toFixed(2)), limits.maxStorageMb),
      dailyMessages: usageMetric(usageCounts.outboundMessagesTodayCount, limits.dailyMessageLimit),
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
