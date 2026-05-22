const { billingRepository } = require("@modules/billing/repositories/index");
const { billingValidation } = require("@modules/billing/validations/index");
const { listResponse } = require("@modules/billing/utils/listResponse");
const { mapWorkspaceSubscriptionItem, mapPlanSummaryItem } = require("@modules/billing/dto/billing.admin.dto");
const { planRepository, subscriptionRepository, purchaseLinkRepository } = require("@modules/billing/repositories/index");
const { HttpError } = require("@shared/utils/httpError");
const { hashIdempotencyParts } = require("@modules/billing/utils/idempotency");
const { calculatePrice } = require("@modules/billing/utils/priceCalculator");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");
const crypto = require("crypto");

function toObjectIdString(value) {
  return String(value || "").trim();
}

function parseScrollQuery(req) {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const limitRaw = Number(req.query.limit || 20) || 20;
  const limit = Math.min(Math.max(limitRaw, 5), 50);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolvePaymentType(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  if (!raw) return "unknown";
  if (["manual", "offline", "complimentary", "adjustment"].includes(raw)) return "manual";
  if (raw.includes("razorpay") || raw.includes("autopay")) return "razorpay";
  return raw;
}

function resolveTransactionId(sub) {
  return (
    sub?.snapshot?.price?.transactionId ||
    sub?.snapshot?.price?.paymentId ||
    sub?.snapshot?.price?.providerRef ||
    sub?.razorpaySubscriptionId ||
    sub?.latestCheckoutIntentId ||
    ""
  );
}

function normalizeLimitSnapshot(raw = {}) {
  return {
    maxContacts: raw.maxContacts ?? 0,
    maxTemplates: raw.maxTemplates ?? 0,
    maxEmployees: raw.maxEmployees ?? 0,
    maxApiKeys: raw.maxApiKeys ?? 0,
    maxCampaignsPerMonth: raw.maxCampaignsPerMonth ?? 0,
    maxContactsExport: raw.maxContactsExport ?? raw.maxExportsPerMonth ?? 0,
    maxStorageMb: raw.maxStorageMb ?? 0,
  };
}

function buildUsageMetric(used, limit) {
  if (limit === null || limit === undefined) return { used, limit: null, remaining: null, percent: 0 };
  const max = Math.max(0, safeNumber(limit, 0));
  const remaining = Math.max(0, max - used);
  const percent = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return { used, limit: max, remaining, percent };
}

function mapPurchaseLink(link) {
  const amount = link.amountSnapshot || {};
  const gst = link.gstSnapshot || {};
  const metadata = link.metadata || {};
  return {
    id: String(link._id),
    workspaceId: String(link.workspaceId),
    userId: String(link.userId),
    planId: String(link.planId),
    planSlug: String(metadata.planSlug || ""),
    planName: String(metadata.planName || ""),
    durationMonths: Number(link.durationMonths || 1),
    status: String(link.status || "active"),
    singleUse: true,
    expiresAt: link.expiresAt || null,
    usedAt: link.usedAt || null,
    createdAt: link.createdAt || null,
    updatedAt: link.updatedAt || null,
    checkoutIntentId: link.metadata?.checkoutIntentId ? String(link.metadata.checkoutIntentId) : null,
    amountSummary: {
      originalPricePaise: safeNumber(amount.originalPricePaise, 0),
      discountedPricePaise: safeNumber(amount.discountedPricePaise, 0),
      discountAmountPaise: safeNumber(amount.discountAmountPaise, 0),
      discountPercent: safeNumber(amount.discountPercent, 0),
      gstPercent: safeNumber(gst.gstPercent, 0),
      gstAmountPaise: safeNumber(gst.gstAmountPaise, 0),
      payableAmountPaise: safeNumber(amount.payableAmountPaise, 0),
    },
  };
}

function buildPurchaseUrl(token) {
  const appBase = String(process.env.APP_BASE_URL || process.env.FRONTEND_URL || "").trim().replace(/\/+$/, "");
  if (appBase) return `${appBase}/app/plan/purchase-link/${encodeURIComponent(token)}`;
  return `/app/plan/purchase-link/${encodeURIComponent(token)}`;
}

async function subscriptionPlans() {
  const items = await billingRepository.aggregatePlans();
  const freeConfig = await getFreePlanConfig();
  const summary = items.map(mapPlanSummaryItem);
  const hasFree = summary.some((entry) => String(entry?.plan || "").toLowerCase() === "free");
  if (!hasFree) {
    summary.push({ plan: "free", count: 0 });
  }
  return { success: true, message: "Subscription plan summary fetched.", data: { summary } };
}

async function subscriptionsData(req) {
  const { page, limit, skip, rx } = billingValidation.parseListQuery(req);
  const filter = rx ? { $or: [{ name: rx }, { plan: rx }] } : {};

  const { total, workspaces, planSummary, latestByWorkspace } = await billingRepository.listSubscriptionsData({ filter, skip, limit });
  const ownerById = await billingRepository.loadOwnersForWorkspaces(workspaces);

  const items = workspaces.map((w) => {
    const owner = ownerById.get(String(w.ownerId));
    const subscription = latestByWorkspace.get(String(w._id)) || null;
    return mapWorkspaceSubscriptionItem(w, owner, subscription);
  });

  return {
    success: true,
    message: "Subscriptions data fetched.",
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
      summary: planSummary.map(mapPlanSummaryItem),
    },
  };
}

async function getWorkspaceSubscriptionOverview(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await billingRepository.findWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const owner = await billingRepository.findOwnerById(workspace.ownerId);
  const subscription = await subscriptionRepository.findLatestByWorkspace(workspace._id);
  const usageCounts = await billingRepository.countWorkspaceUsage(workspace._id);

  const mapped = mapWorkspaceSubscriptionItem(workspace, owner, subscription);
  const limits = normalizeLimitSnapshot(mapped.subscription?.limits || {});

  const usage = {
    contacts: buildUsageMetric(usageCounts.contactsCount, limits.maxContacts),
    templates: buildUsageMetric(usageCounts.templatesCount, limits.maxTemplates),
    employees: buildUsageMetric(usageCounts.employeesCount, limits.maxEmployees),
    campaigns: buildUsageMetric(usageCounts.campaignsCount, limits.maxCampaignsPerMonth),
  };

  return {
    success: true,
    message: "Subscription overview fetched.",
    data: {
      item: {
        ...mapped,
        workspaceId: mapped.id,
        usage,
      },
    },
  };
}

async function listWorkspaceSubscriptionHistory(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const { page, limit, skip } = parseScrollQuery(req);
  const [itemsRaw, total] = await Promise.all([
    subscriptionRepository.listByWorkspace(workspaceId, { skip, limit }),
    subscriptionRepository.countByWorkspace(workspaceId),
  ]);

  const items = itemsRaw.map((sub) => ({
    id: String(sub._id),
    planName: sub.planName || "",
    planSlug: sub.planSlug || "",
    status: sub.status || "",
    paymentType: resolvePaymentType(sub.paymentMode),
    transactionId: String(resolveTransactionId(sub) || ""),
    durationMonths: Number(sub.durationMonths || 1),
    currentPeriodStart: sub.currentPeriodStart || null,
    currentPeriodEnd: sub.currentPeriodEnd || null,
    autoRenewEnabled: Boolean(sub.autoRenewEnabled),
    paymentMode: sub.paymentMode || "",
    createdAt: sub.createdAt || null,
    amountPaidPaise: safeNumber(sub.snapshot?.price?.discountedPricePaise, 0),
    gstAmountPaise: safeNumber(sub.snapshot?.gst?.gstAmountPaise, 0),
    payableAmountPaise: safeNumber(sub.snapshot?.price?.payableAmountPaise, 0),
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

async function listWorkspacePaymentLinks(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  const { page, limit, skip } = parseScrollQuery(req);

  const [itemsRaw, total] = await Promise.all([
    purchaseLinkRepository.listPurchaseLinksByWorkspace(workspaceId, { skip, limit }),
    purchaseLinkRepository.countPurchaseLinksByWorkspace(workspaceId),
  ]);

  return {
    success: true,
    message: "Payment links fetched.",
    data: {
      items: itemsRaw.map(mapPurchaseLink),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    },
  };
}

async function assignPlanToWorkspace(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await billingRepository.findWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const planId = toObjectIdString(req.body?.planId);
  const durationMonths = Math.max(1, Math.min(24, Number(req.body?.durationMonths || 1)));
  if (!planId) throw new HttpError(400, "planId is required");

  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");

  const owner = await billingRepository.findOwnerById(workspace.ownerId);
  if (!owner) throw new HttpError(404, "Workspace owner not found");

  const pricePreview = calculatePrice({
    originalPricePaise: plan.pricing?.originalPricePaise ?? null,
    discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
    gstPercent: plan.pricing?.gstPercent ?? 18,
    taxMode: plan.pricing?.taxMode || "exclusive",
  });

  const now = new Date();
  const currentPeriodEnd = new Date(now);
  currentPeriodEnd.setMonth(currentPeriodEnd.getMonth() + durationMonths);

  const active = await subscriptionRepository.findActiveByWorkspace(workspace._id);
  if (active) {
    active.status = "cancelled";
    active.cancelledAt = now;
    await active.save();
  }

  const created = await subscriptionRepository.createSubscription({
    workspaceId: workspace._id,
    userId: owner._id,
    planId: plan._id,
    planSlug: plan.slug,
    planName: plan.name,
    planType: plan.planType || "custom",
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd,
    durationMonths,
    autoRenewEnabled: false,
    cancelAtPeriodEnd: false,
    snapshot: {
      price: {
        originalPricePaise: plan.pricing?.originalPricePaise ?? null,
        discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
        discountAmountPaise: pricePreview.discountAmountPaise,
        discountPercent: pricePreview.discountPercent,
        payableAmountPaise: pricePreview.payableAmountPaise,
      },
      gst: {
        gstPercent: plan.pricing?.gstPercent ?? 18,
        gstAmountPaise: pricePreview.gstAmountPaise,
        taxMode: plan.pricing?.taxMode || "exclusive",
      },
      features: plan.features || {},
      limits: plan.limits || {},
      displayFeatures: plan.displayFeatures || [],
      unavailableFeatures: plan.unavailableFeatures || [],
    },
    paymentMode: String(req.body?.paymentMode || "manual"),
    assignedBy: req.user?.id || null,
    assignmentReason: String(req.body?.reason || "").trim(),
  });

  workspace.plan = plan.slug;
  workspace.crmEnabled = Boolean(plan.features?.crmAccess);
  workspace.features = workspace.features || {};
  workspace.features.externalChatApiAccess = Boolean(plan.features?.externalChatApiAccess);
  workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
  workspace.allowedApiPermissions.chatAccess = Boolean(plan.features?.externalChatApiAccess);
  await workspace.save();

  return {
    success: true,
    message: "Plan assigned successfully.",
    data: {
      subscriptionId: String(created._id),
      workspaceId: String(workspace._id),
      planSlug: plan.slug,
      validFrom: created.currentPeriodStart,
      validUntil: created.currentPeriodEnd,
    },
  };
}

async function createWorkspacePaymentLink(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await billingRepository.findWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const owner = await billingRepository.findOwnerById(workspace.ownerId);
  if (!owner) throw new HttpError(404, "Workspace owner not found");

  const planId = toObjectIdString(req.body?.planId);
  const durationMonths = Math.max(1, Math.min(24, Number(req.body?.durationMonths || 1)));
  if (!planId) throw new HttpError(400, "planId is required");

  const plan = await planRepository.findById(planId);
  if (!plan) throw new HttpError(404, "Plan not found");

  const expiresInHours = Math.max(1, Math.min(168, Number(req.body?.expiresInHours || 72)));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000);

  const price = calculatePrice({
    originalPricePaise: plan.pricing?.originalPricePaise ?? null,
    discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
    gstPercent: plan.pricing?.gstPercent ?? 18,
    taxMode: plan.pricing?.taxMode || "exclusive",
  });

  const rawToken = crypto.randomBytes(24).toString("hex");
  const tokenHash = hashIdempotencyParts(["purchase-link", rawToken, workspaceId, Date.now()]);

  const link = await purchaseLinkRepository.createPurchaseLink({
    tokenHash,
    workspaceId: workspace._id,
    userId: owner._id,
    planId: plan._id,
    durationMonths,
    amountSnapshot: {
      originalPricePaise: plan.pricing?.originalPricePaise ?? null,
      discountedPricePaise: plan.pricing?.discountedPricePaise ?? null,
      discountAmountPaise: price.discountAmountPaise,
      discountPercent: price.discountPercent,
      payableAmountPaise: price.payableAmountPaise,
    },
    gstSnapshot: {
      gstPercent: plan.pricing?.gstPercent ?? 18,
      gstAmountPaise: price.gstAmountPaise,
      taxMode: plan.pricing?.taxMode || "exclusive",
    },
    featuresSnapshot: plan.features || {},
    limitsSnapshot: plan.limits || {},
    status: "active",
    expiresAt,
    createdBy: req.user?.id || null,
    metadata: {
      planSlug: plan.slug,
      planName: plan.name,
      tokenPreview: rawToken.slice(-8),
    },
  });

  return {
    success: true,
    message: "Payment link generated.",
    data: {
      item: {
        ...mapPurchaseLink(link),
        planSlug: plan.slug,
        planName: plan.name,
        payableAmountPaise: price.payableAmountPaise,
        purchaseUrl: buildPurchaseUrl(rawToken),
      },
    },
  };
}

async function cancelWorkspacePaymentLink(req) {
  const id = toObjectIdString(req.params.id);
  if (!id) throw new HttpError(400, "id is required");

  const link = await purchaseLinkRepository.findPurchaseLinkById(id);
  if (!link) throw new HttpError(404, "Payment link not found");
  if (link.status !== "active") {
    return { success: true, message: "Payment link already inactive.", data: { item: mapPurchaseLink(link) } };
  }

  const updated = await purchaseLinkRepository.cancelPurchaseLinkById(id);
  return { success: true, message: "Payment link cancelled.", data: { item: mapPurchaseLink(updated) } };
}

async function disableActivePlanForWorkspace(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await billingRepository.findWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const active = await subscriptionRepository.findActiveByWorkspace(workspace._id);
  if (!active) {
    return {
      success: true,
      message: "No active subscription found for workspace.",
      data: { workspaceId: String(workspace._id), disabled: false },
    };
  }

  const now = new Date();
  active.status = "cancelled";
  active.cancelledAt = now;
  active.cancelAtPeriodEnd = false;
  active.autoRenewEnabled = false;
  await active.save();

  workspace.plan = "free";
  workspace.crmEnabled = false;
  workspace.features = workspace.features || {};
  workspace.features.externalChatApiAccess = false;
  workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
  workspace.allowedApiPermissions.chatAccess = false;
  await workspace.save();

  return {
    success: true,
    message: "Active plan disabled successfully.",
    data: {
      workspaceId: String(workspace._id),
      subscriptionId: String(active._id),
      disabled: true,
      disabledAt: now,
    },
  };
}

async function paymentGateway(req) {
  const { page, limit } = billingValidation.parsePaging(req);
  return listResponse({ items: [], total: 0, page, limit });
}

module.exports = {
  subscriptionPlans,
  subscriptionsData,
  getWorkspaceSubscriptionOverview,
  listWorkspaceSubscriptionHistory,
  listWorkspacePaymentLinks,
  assignPlanToWorkspace,
  createWorkspacePaymentLink,
  cancelWorkspacePaymentLink,
  disableActivePlanForWorkspace,
  paymentGateway,
};
