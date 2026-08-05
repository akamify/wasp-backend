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
const { Workspace } = require("@infra/database/Workspace");
const { Subscription } = require("@infra/database/Subscription");
const { Plan } = require("@infra/database/Plan");
const { AuditLog } = require("@infra/database/AuditLog");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");

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

function addMonths(date, months) {
  const out = new Date(date);
  out.setMonth(out.getMonth() + Number(months || 1));
  return out;
}

function parseDateInput(value, endOfDay = false) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}${endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"}` : raw;
  const dt = new Date(normalized);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function normalizeBoolFilter(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "all") return null;
  if (["1", "true", "enabled", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "disabled", "no", "off"].includes(raw)) return false;
  return null;
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
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
  const pick = (value, fallback = 0) => (value === null ? null : (value === undefined ? fallback : value));
  return {
    maxContacts: pick(raw.maxContacts),
    maxTemplates: pick(raw.maxTemplates),
    maxEmployees: pick(raw.maxEmployees, raw.maxAgents),
    maxApiKeys: pick(raw.maxApiKeys),
    maxCampaignsPerMonth: pick(raw.maxCampaignsPerMonth),
    maxContactsExport: pick(raw.maxContactsExport, raw.maxExportsPerMonth ?? 0),
    maxStorageMb: pick(raw.maxStorageMb),
    maxWebhooks: pick(raw.maxWebhooks),
    maxFlows: pick(raw.maxFlows),
    maxMediaSizeMb: pick(raw.maxMediaSizeMb),
    dailyMessageLimit: pick(raw.dailyMessageLimit),
  };
}

function isWorkspaceBlocked(workspace) {
  return String(workspace?.status || "active") !== "active" || workspace?.isActive === false;
}

function buildAiDiagnostics({ workspace, subscription, plan, entitlements }) {
  const paidPlan = lower(subscription?.planSlug || workspace?.plan) && lower(subscription?.planSlug || workspace?.plan) !== "free";
  const explicitAiAccess = plan ? Boolean(plan.features?.aiAgentsPageAccess) : Boolean(subscription?.snapshot?.features?.aiAgentsPageAccess);
  const effectiveAiAccess = Boolean(entitlements?.features?.aiAgentsPageAccess);
  const blocked = isWorkspaceBlocked(workspace);
  const aiAddonActive = Boolean(workspace?.aiAgentEnabled);
  let aiBlockedReason = null;
  if (blocked) aiBlockedReason = "workspace_blocked";
  else if (!paidPlan) aiBlockedReason = "plan_upgrade_required";
  else if (!effectiveAiAccess) aiBlockedReason = "feature_disabled";
  else if (aiAddonActive) aiBlockedReason = "ai_addon_active";
  return {
    aiAgentsPageAccess: effectiveAiAccess,
    aiFeatureEligible: !blocked && effectiveAiAccess,
    aiPurchaseEligible: !blocked && effectiveAiAccess && !aiAddonActive,
    aiBlockedReason,
    aiMismatch: Boolean(paidPlan && effectiveAiAccess && explicitAiAccess !== effectiveAiAccess),
  };
}

async function loadWorkspaceAuditTimeline(workspaceId, limit = 25) {
  const items = await AuditLog.find({
    $or: [{ resourceId: String(workspaceId) }, { "metadata.workspaceId": String(workspaceId) }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return items.map((row) => ({
    id: String(row._id),
    action: row.action,
    resourceType: row.resourceType || "",
    resourceId: row.resourceId || "",
    metadata: row.metadata || {},
    actorId: row.actorId ? String(row.actorId) : null,
    createdAt: row.createdAt || null,
  }));
}

function applyWorkspacePlanState(workspace, planSlug, features = {}) {
  workspace.plan = planSlug || "free";
  workspace.crmEnabled = Boolean(features?.crmPageAccess || features?.crmAccess);
  workspace.features = workspace.features || {};
  workspace.features.externalChatApiAccess = Boolean(features?.externalChatApiAccess);
  workspace.allowedApiPermissions = workspace.allowedApiPermissions || {};
  workspace.allowedApiPermissions.chatAccess = Boolean(features?.externalChatApiAccess);
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
  const { page, limit, rx } = billingValidation.parseListQuery(req);
  const filter = rx ? { $or: [{ name: rx }, { plan: rx }] } : {};
  const planId = String(req.query.planId || "").trim();
  const subscriptionStatus = lower(req.query.status);
  const workspaceStatus = lower(req.query.workspaceStatus);
  const billingMode = lower(req.query.billingMode);
  const autoRenew = normalizeBoolFilter(req.query.autoRenew);
  const dateFrom = parseDateInput(req.query.dateFrom, false);
  const dateTo = parseDateInput(req.query.dateTo, true);

  const { workspaces, latestByWorkspace } = await billingRepository.listWorkspaceSubscriptions({ filter });
  const ownerById = await billingRepository.loadOwnersForWorkspaces(workspaces);
  const planIds = Array.from(
    new Set(
      workspaces
        .map((workspace) => latestByWorkspace.get(String(workspace._id)))
        .filter(Boolean)
        .map((subscription) => String(subscription.planId || ""))
        .filter(Boolean)
    )
  );
  const plans = planIds.length
    ? await Plan.find({ _id: { $in: planIds } }).select("slug name features.aiAgentsPageAccess").lean()
    : [];
  const planById = new Map(plans.map((plan) => [String(plan._id), plan]));

  const filteredItems = [];
  for (const workspace of workspaces) {
    const owner = ownerById.get(String(workspace.ownerId));
    const subscription = latestByWorkspace.get(String(workspace._id)) || null;
    const item = mapWorkspaceSubscriptionItem(workspace, owner, subscription);
    const entitlementSnapshot = await getWorkspaceEntitlements(workspace._id);
    const plan = subscription?.planId ? planById.get(String(subscription.planId)) || null : null;
    const purchasedAt = subscription?.createdAt ? new Date(subscription.createdAt) : null;
    const paymentType = resolvePaymentType(subscription?.paymentMode);

    if (planId) {
      const matchesPlan =
        String(subscription?.planId || "") === planId ||
        lower(subscription?.planSlug) === lower(planId) ||
        lower(subscription?.planName) === lower(planId);
      if (!matchesPlan) continue;
    }
    if (subscriptionStatus && subscriptionStatus !== "all" && lower(subscription?.status) !== subscriptionStatus) continue;
    if (workspaceStatus && workspaceStatus !== "all" && lower(workspace?.status) !== workspaceStatus) continue;
    if (billingMode && billingMode !== "all" && lower(paymentType) !== billingMode && lower(subscription?.paymentMode) !== billingMode) continue;
    if (autoRenew !== null && Boolean(subscription?.autoRenewEnabled) !== autoRenew) continue;
    if (dateFrom && (!purchasedAt || purchasedAt < dateFrom)) continue;
    if (dateTo && (!purchasedAt || purchasedAt > dateTo)) continue;

    filteredItems.push({
      ...item,
      workspaceStatus: workspace.status || "active",
      aiDiagnostics: buildAiDiagnostics({
        workspace,
        subscription,
        plan,
        entitlements: entitlementSnapshot,
      }),
    });
  }

  const total = filteredItems.length;
  const skip = (page - 1) * limit;
  const items = filteredItems.slice(skip, skip + limit);
  const rollupMap = new Map();
  let totalRevenuePaise = 0;
  let activeSubscriptions = 0;
  let cancelledSubscriptions = 0;
  let blockedWorkspaces = 0;
  let autoRenewEnabledCount = 0;

  for (const item of filteredItems) {
    const subscription = item.subscription || {};
    const key = String(subscription.planSlug || item.plan || "free").toLowerCase() || "free";
    const rollup = rollupMap.get(key) || {
      plan: key,
      planName: subscription.planName || item.plan || "Free",
      workspaceCount: 0,
      purchasesCount: 0,
      activeCount: 0,
      cancelledCount: 0,
      blockedCount: 0,
      revenuePaise: 0,
    };
    rollup.workspaceCount += 1;
    if (subscription.id) rollup.purchasesCount += 1;
    if (["active", "past_due", "grace_period"].includes(lower(subscription.subscriptionStatus))) {
      rollup.activeCount += 1;
      activeSubscriptions += 1;
    }
    if (["cancelled", "expired", "replaced", "suspended"].includes(lower(subscription.subscriptionStatus))) {
      rollup.cancelledCount += 1;
      cancelledSubscriptions += 1;
    }
    if (item.workspaceStatus === "suspended") {
      rollup.blockedCount += 1;
      blockedWorkspaces += 1;
    }
    if (subscription.autoRenewEnabled) autoRenewEnabledCount += 1;
    rollup.revenuePaise += safeNumber(subscription.payableAmountPaise, 0);
    totalRevenuePaise += safeNumber(subscription.payableAmountPaise, 0);
    rollupMap.set(key, rollup);
  }
  const planRollups = Array.from(rollupMap.values()).sort((a, b) => b.workspaceCount - a.workspaceCount);

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
      summary: planRollups.map((entry) => ({ plan: entry.plan, count: entry.workspaceCount })),
      analytics: {
        totalWorkspaces: total,
        activeSubscriptions,
        cancelledSubscriptions,
        blockedWorkspaces,
        autoRenewEnabledCount,
        totalRevenuePaise,
        planRollups,
      },
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
  const plan = subscription?.planId ? await Plan.findById(subscription.planId).select("slug name features.aiAgentsPageAccess").lean() : null;
  const entitlements = await getWorkspaceEntitlements(workspace._id);
  const usageCounts = await billingRepository.countWorkspaceUsage(workspace._id);
  const auditTimeline = await loadWorkspaceAuditTimeline(workspace._id);

  const mapped = mapWorkspaceSubscriptionItem(workspace, owner, subscription);
  const limits = normalizeLimitSnapshot(mapped.subscription?.limits || {});

  const usage = {
    contacts: buildUsageMetric(usageCounts.contactsCount, limits.maxContacts),
    templates: buildUsageMetric(usageCounts.templatesCount, limits.maxTemplates),
    employees: buildUsageMetric(usageCounts.employeesCount, limits.maxEmployees),
    campaigns: buildUsageMetric(usageCounts.campaignsCount, limits.maxCampaignsPerMonth),
    apiKeys: buildUsageMetric(usageCounts.apiKeysCount, limits.maxApiKeys),
    webhooks: buildUsageMetric(usageCounts.webhooksCount, limits.maxWebhooks),
    flows: buildUsageMetric(usageCounts.flowsCount, limits.maxFlows),
    storage: buildUsageMetric(Number(((usageCounts.storageBytes || 0) / (1024 * 1024)).toFixed(2)), limits.maxStorageMb),
    dailyMessages: buildUsageMetric(usageCounts.outboundMessagesTodayCount, limits.dailyMessageLimit),
  };

  return {
    success: true,
    message: "Subscription overview fetched.",
    data: {
      item: {
        ...mapped,
        workspaceId: mapped.id,
        usage,
        workspaceStatus: workspace.status || "active",
        aiDiagnostics: buildAiDiagnostics({ workspace, subscription, plan, entitlements }),
        auditTimeline,
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
      addonServices: plan.addonServices || [],
    },
    paymentMode: String(req.body?.paymentMode || "manual"),
    assignedBy: req.user?.id || null,
    assignmentReason: String(req.body?.reason || "").trim(),
  });

  applyWorkspacePlanState(workspace, plan.slug, plan.features || {});
  workspace.status = "active";
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
  const before = {
    workspaceStatus: workspace.status || "active",
    planSlug: active.planSlug || workspace.plan || "free",
    subscriptionStatus: active.status || "active",
  };
  active.status = "cancelled";
  active.cancelledAt = now;
  active.cancelAtPeriodEnd = false;
  active.autoRenewEnabled = false;
  active.renewalStatus = "disabled";
  active.metadata = {
    ...(active.metadata || {}),
    disabledBy: req.user?.id || null,
    disabledReason: String(req.body?.reason || "Workspace plan deactivated").trim(),
    disabledBySuperAdmin: Boolean(req.body?.superAdminAction),
  };
  await active.save();

  const freePlan = await getFreePlanConfig();
  applyWorkspacePlanState(workspace, "free", freePlan.features || {});
  await workspace.save();

  return {
    success: true,
    message: "Active plan disabled successfully.",
    data: {
      workspaceId: String(workspace._id),
      subscriptionId: String(active._id),
      disabled: true,
      disabledAt: now,
      before,
      after: {
        workspaceStatus: workspace.status || "active",
        planSlug: "free",
        subscriptionStatus: active.status,
      },
    },
  };
}

async function activateWorkspacePlanForWorkspace(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const active = await subscriptionRepository.findActiveByWorkspace(workspace._id);
  const before = {
    workspaceStatus: workspace.status || "active",
    planSlug: active?.planSlug || workspace.plan || "free",
    subscriptionStatus: active?.status || null,
  };

  if (active) {
    workspace.status = "active";
    await workspace.save();
    return {
      success: true,
      message: "Workspace access restored successfully.",
      data: {
        workspaceId: String(workspace._id),
        subscriptionId: String(active._id),
        activated: true,
        before,
        after: {
          workspaceStatus: workspace.status || "active",
          planSlug: active.planSlug || workspace.plan || "free",
          subscriptionStatus: active.status,
        },
      },
    };
  }

  const latest = await Subscription.findOne({ workspaceId: workspace._id }).sort({ createdAt: -1 });
  if (!latest) throw new HttpError(404, "No previous plan assignment found for this workspace");

  const plan = latest.planId ? await planRepository.findById(latest.planId) : null;
  const now = new Date();
  const currentPeriodEnd = addMonths(now, Math.max(1, Number(latest.durationMonths || 1)));
  const restoredFeatures = plan?.features || latest.snapshot?.features || {};
  const restoredLimits = plan?.limits || latest.snapshot?.limits || {};
  const restored = await subscriptionRepository.createSubscription({
    workspaceId: workspace._id,
    userId: latest.userId || workspace.ownerId,
    planId: plan?._id || latest.planId,
    planSlug: plan?.slug || latest.planSlug,
    planName: plan?.name || latest.planName,
    planType: latest.planType || plan?.planType || "custom",
    status: "active",
    currentPeriodStart: now,
    currentPeriodEnd,
    startedAt: now,
    purchasedAt: now,
    validUntil: currentPeriodEnd,
    durationMonths: Math.max(1, Number(latest.durationMonths || 1)),
    autoRenewEnabled: false,
    cancelAtPeriodEnd: false,
    snapshot: {
      price: latest.snapshot?.price || {},
      gst: latest.snapshot?.gst || {},
      features: restoredFeatures,
      limits: restoredLimits,
      displayFeatures: latest.snapshot?.displayFeatures || [],
      unavailableFeatures: latest.snapshot?.unavailableFeatures || [],
      addonServices: latest.snapshot?.addonServices || [],
    },
    paymentMode: "manual",
    assignedBy: req.user?.id || null,
    assignmentReason: String(req.body?.reason || "Workspace plan activated by super admin").trim(),
    renewalMethod: "manual",
    renewalStatus: "manual_due",
    mandateStatus: "not_setup",
  });

  applyWorkspacePlanState(workspace, restored.planSlug || plan?.slug || latest.planSlug, restoredFeatures);
  workspace.status = "active";
  await workspace.save();

  return {
    success: true,
    message: "Workspace plan activated successfully.",
    data: {
      workspaceId: String(workspace._id),
      subscriptionId: String(restored._id),
      activated: true,
      before,
      after: {
        workspaceStatus: workspace.status || "active",
        planSlug: restored.planSlug || workspace.plan || "free",
        subscriptionStatus: restored.status,
      },
    },
  };
}

async function blockWorkspacePlanAccess(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const active = await subscriptionRepository.findActiveByWorkspace(workspace._id);
  const before = {
    workspaceStatus: workspace.status || "active",
    planSlug: active?.planSlug || workspace.plan || "free",
    subscriptionStatus: active?.status || null,
  };
  workspace.status = "suspended";
  await workspace.save();

  return {
    success: true,
    message: "Workspace blocked successfully.",
    data: {
      workspaceId: String(workspace._id),
      blocked: true,
      before,
      after: {
        workspaceStatus: workspace.status || "suspended",
        planSlug: workspace.plan || "free",
        subscriptionStatus: active?.status || null,
      },
    },
  };
}

async function deleteWorkspacePlanAssignment(req) {
  const workspaceId = toObjectIdString(req.params.workspaceId);
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");

  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const active = await subscriptionRepository.findActiveByWorkspace(workspace._id);
  const before = {
    workspaceStatus: workspace.status || "active",
    planSlug: active?.planSlug || workspace.plan || "free",
    subscriptionStatus: active?.status || null,
  };

  if (active) {
    active.status = "cancelled";
    active.cancelledAt = new Date();
    active.cancelAtPeriodEnd = false;
    active.autoRenewEnabled = false;
    active.renewalStatus = "disabled";
    active.metadata = {
      ...(active.metadata || {}),
      assignmentDeletedAt: new Date(),
      assignmentDeletedBy: req.user?.id || null,
      assignmentDeleteReason: String(req.body?.reason || "Workspace plan assignment removed by super admin").trim(),
    };
    await active.save();
  }

  const freePlan = await getFreePlanConfig();
  applyWorkspacePlanState(workspace, "free", freePlan.features || {});
  await workspace.save();

  return {
    success: true,
    message: "Workspace plan assignment removed successfully.",
    data: {
      workspaceId: String(workspace._id),
      subscriptionId: active ? String(active._id) : null,
      deleted: true,
      before,
      after: {
        workspaceStatus: workspace.status || "active",
        planSlug: "free",
        subscriptionStatus: active?.status || null,
      },
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
  activateWorkspacePlanForWorkspace,
  blockWorkspacePlanAccess,
  deleteWorkspacePlanAssignment,
  paymentGateway,
};
