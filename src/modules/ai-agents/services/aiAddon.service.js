const mongoose = require("mongoose");
const { AiSubscription } = require("@infra/database/AiSubscription");
const { AiCreditTransaction } = require("@infra/database/AiCreditTransaction");
const { AiAddonPlan } = require("@infra/database/AiAddonPlan");
const { AiTopupPack } = require("@infra/database/AiTopupPack");
const { Workspace } = require("@infra/database/Workspace");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");
const walletCoreService = require("@modules/wallet/services/wallet.core.service");
const { HttpError } = require("@shared/utils/httpError");

const AI_AGENT_ADDON_PLAN_KEY = "ai_agent_addon";
const AI_AGENT_ADDON_PLAN_NAME = process.env.AI_AGENT_ADDON_PLAN_NAME || "AI Agent Add-on";
const AI_AGENT_ADDON_PRICE = Math.max(0, Number(process.env.AI_AGENT_ADDON_PRICE_INR || 2500) || 2500);
const AI_AGENT_ADDON_INCLUDED_CREDITS = Math.max(0, Number(process.env.AI_AGENT_ADDON_INCLUDED_CREDITS || 500) || 500);
const AI_AGENT_TOKENS_PER_CREDIT = Math.max(1, Number(process.env.AI_AGENT_TOKENS_PER_CREDIT || 1000) || 1000);
const AI_AGENT_ADDON_DURATION_DAYS = Math.max(1, Number(process.env.AI_AGENT_ADDON_DURATION_DAYS || 30) || 30);

function parseTopupPacks() {
  const fallback = [
    { packId: "ai_credits_100", label: "100 Credits", description: "", credits: 100, price: 299, currency: "INR", sortOrder: 10, featured: false },
    { packId: "ai_credits_500", label: "500 Credits", description: "", credits: 500, price: 999, currency: "INR", sortOrder: 20, featured: true },
    { packId: "ai_credits_1000", label: "1000 Credits", description: "", credits: 1000, price: 1799, currency: "INR", sortOrder: 30, featured: false },
  ];
  const raw = String(process.env.AI_AGENT_TOPUP_PACKS_JSON || "").trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed
      .map((item, index) => ({
        packId: String(item?.packId || `ai_pack_${index + 1}`).trim().toLowerCase(),
        label: String(item?.label || `${Number(item?.credits || 0)} Credits`).trim(),
        description: String(item?.description || "").trim(),
        credits: Math.max(1, Number(item?.credits || 0) || 0),
        price: Math.max(0, Number(item?.price || 0) || 0),
        currency: String(item?.currency || "INR").trim() || "INR",
        sortOrder: Math.max(0, Number(item?.sortOrder || index * 10) || 0),
        featured: Boolean(item?.featured),
      }))
      .filter((item) => item.packId && item.credits > 0)
      .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder));
  } catch {
    return fallback;
  }
}

function buildFallbackCatalog() {
  return {
    planKey: AI_AGENT_ADDON_PLAN_KEY,
    planName: AI_AGENT_ADDON_PLAN_NAME,
    description: "",
    currency: "INR",
    monthlyPrice: AI_AGENT_ADDON_PRICE,
    includedCredits: AI_AGENT_ADDON_INCLUDED_CREDITS,
    tokensPerCredit: AI_AGENT_TOKENS_PER_CREDIT,
    includedTokens: creditsToTokens(AI_AGENT_ADDON_INCLUDED_CREDITS, AI_AGENT_TOKENS_PER_CREDIT),
    durationDays: AI_AGENT_ADDON_DURATION_DAYS,
    limits: {
      maxAgents: 1,
      maxKbStorageMb: 500,
      maxInputTokens: 4096,
      maxTokensPerReply: 1024,
    },
    renewalPolicy: {
      mode: "auto_renew",
      expireUnusedCredits: true,
      expireUnusedIncludedCredits: true,
      preservePurchasedTopupCredits: true,
    },
    topupPacks: parseTopupPacks(),
    source: "fallback",
  };
}

function creditsToTokens(credits, tokensPerCredit = AI_AGENT_TOKENS_PER_CREDIT) {
  return Math.max(0, Math.round(Number(credits || 0) * Number(tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)));
}

function tokensToCreditsExact(tokens, tokensPerCredit = AI_AGENT_TOKENS_PER_CREDIT) {
  return Number((Math.max(0, Number(tokens || 0)) / Number(tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)).toFixed(3));
}

function tokensToVisibleCredits(tokens, tokensPerCredit = AI_AGENT_TOKENS_PER_CREDIT) {
  return Math.floor(Math.max(0, Number(tokens || 0)) / Number(tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT));
}

function normalizeAiLimits(limits = {}, fallbackLimits = {}) {
  return {
    maxAgents: Math.max(0, Number(limits.maxAgents ?? fallbackLimits.maxAgents ?? 0) || 0),
    maxKbStorageMb: Math.max(0, Number(limits.maxKbStorageMb ?? fallbackLimits.maxKbStorageMb ?? 0) || 0),
    maxInputTokens: Math.max(1, Number(limits.maxInputTokens ?? fallbackLimits.maxInputTokens ?? 4096) || 4096),
    maxTokensPerReply: Math.max(1, Number(limits.maxTokensPerReply ?? fallbackLimits.maxTokensPerReply ?? 1024) || 1024),
  };
}

function serializeRenewalPolicy(policy = {}) {
  return {
    mode: String(policy?.mode || "auto_renew"),
    expireUnusedCredits: policy?.expireUnusedCredits !== false,
    expireUnusedIncludedCredits: true,
    preservePurchasedTopupCredits: true,
  };
}

function toObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

function normalizeLedgerEntryType(type, providedEntryType = "", metadata = {}) {
  if (providedEntryType) return String(providedEntryType);
  const topupTokensUsed = Math.max(
    0,
    Number(metadata?.breakdown?.topupTokensUsed || metadata?.topupTokensUsed || metadata?.billing?.topupTokensUsed || 0)
  );
  switch (String(type || "")) {
    case "purchase":
      return "included_credit_allocation";
    case "monthly_reset":
      return "subscription_reset";
    case "topup_purchase":
      return "topup_purchase";
    case "refund":
      return "refund";
    case "adjustment":
      if (String(metadata?.source || "").toLowerCase() === "migration") return "migration_adjustment";
      return "manual_adjustment";
    case "usage":
      return topupTokensUsed > 0 ? "topup_usage" : "included_credit_usage";
    default:
      return null;
  }
}

function normalizeLedgerActor({ actor = null, userId = null, metadata = {} } = {}) {
  const actorType = String(
    actor?.actorType || metadata?.actorType || (userId ? "workspace_user" : metadata?.system ? "system" : "system")
  );
  return {
    actorType: ["system", "workspace_user", "super_admin", "admin", "runtime"].includes(actorType) ? actorType : "system",
    actorId: toObjectId(actor?.actorId || metadata?.actorId || userId || null),
    actorName: String(actor?.actorName || metadata?.actorName || "").trim(),
  };
}

function balanceSnapshot(subscription) {
  const tokensPerCredit = Number(subscription?.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT);
  const remainingIncludedTokens = Math.max(0, Number(subscription?.remainingIncludedTokens || 0));
  const remainingTopupTokens = Math.max(0, Number(subscription?.remainingTopupTokens || 0));
  const remainingTokens = remainingIncludedTokens + remainingTopupTokens;
  return {
    remainingIncludedTokens,
    remainingTopupTokens,
    remainingTokens,
    remainingCredits: tokensToVisibleCredits(remainingTokens, tokensPerCredit),
    remainingIncludedCredits: tokensToVisibleCredits(remainingIncludedTokens, tokensPerCredit),
    remainingTopupCredits: tokensToVisibleCredits(remainingTopupTokens, tokensPerCredit),
    totalCredits: tokensToVisibleCredits(Number(subscription?.includedTokensPerCycle || 0) + Number(subscription?.remainingTopupTokens || 0), tokensPerCredit),
  };
}

function buildWorkspaceAddonUpdate(subscription) {
  const snapshot = balanceSnapshot(subscription);
  return {
    aiAgentEnabled: subscription.status === "active",
    aiSubscriptionId: subscription._id,
    aiIncludedCredits: tokensToVisibleCredits(Number(subscription.includedTokensPerCycle || 0), Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
    aiTotalCredits: snapshot.totalCredits,
    aiRemainingCredits: snapshot.remainingCredits,
    aiRemainingTokens: snapshot.remainingTokens,
    aiRenewDate: subscription.renewalDate || null,
    aiAddonActivatedAt: subscription.activatedAt || null,
    aiAddonPlanKey: subscription.planKey || AI_AGENT_ADDON_PLAN_KEY,
  };
}

async function syncWorkspaceAddonState({ workspaceId, subscription }) {
  if (!workspaceId) return null;
  if (!subscription) {
    return Workspace.findByIdAndUpdate(
      workspaceId,
      {
        $set: {
          aiAgentEnabled: false,
          aiSubscriptionId: null,
          aiIncludedCredits: 0,
          aiTotalCredits: 0,
          aiRemainingCredits: 0,
          aiRemainingTokens: 0,
          aiRenewDate: null,
          aiAddonActivatedAt: null,
          aiAddonPlanKey: "",
        },
      },
      { new: true }
    );
  }
  return Workspace.findByIdAndUpdate(workspaceId, { $set: buildWorkspaceAddonUpdate(subscription) }, { new: true });
}

async function createCreditTransaction({
  workspaceId,
  subscription,
  userId = null,
  executionKey = null,
  type,
  entryType = "",
  source = "",
  reason = "",
  reference = "",
  actor = null,
  direction,
  credits = 0,
  tokens = 0,
  amount = 0,
  currency = "INR",
  description = "",
  conversationId = null,
  agentId = null,
  metadata = {},
}) {
  const snapshot = balanceSnapshot(subscription || {});
  return AiCreditTransaction.create({
    workspaceId,
    subscriptionId: subscription?._id || null,
    userId: userId || null,
    executionKey: executionKey ? String(executionKey) : null,
    type,
    entryType: normalizeLedgerEntryType(type, entryType, metadata),
    source: String(source || metadata?.source || "").trim(),
    reason: String(reason || metadata?.reason || "").trim(),
    reference: String(reference || metadata?.reference || "").trim(),
    conversationId: toObjectId(conversationId || metadata?.conversationId || null),
    agentId: toObjectId(agentId || metadata?.agentId || null),
    actor: normalizeLedgerActor({ actor, userId, metadata }),
    immutable: true,
    direction,
    credits: Number(credits || 0),
    tokens: Math.max(0, Number(tokens || 0)),
    amount: Number(amount || 0),
    currency,
    description,
    balanceAfter: {
      remainingCredits: snapshot.remainingCredits,
      remainingTokens: snapshot.remainingTokens,
      remainingIncludedTokens: snapshot.remainingIncludedTokens,
      remainingTopupTokens: snapshot.remainingTopupTokens,
      remainingIncludedCredits: snapshot.remainingIncludedCredits,
      remainingTopupCredits: snapshot.remainingTopupCredits,
    },
    metadata,
  });
}

async function findPublishedPlan() {
  return AiAddonPlan.findOne({ status: "published" }).sort({ isDefault: -1, featured: -1, sortOrder: 1, createdAt: -1 }).lean();
}

async function findPublishedTopupPacks() {
  return AiTopupPack.find({ status: "published" }).sort({ featured: -1, sortOrder: 1, createdAt: 1 }).lean();
}

async function getCatalogConfig() {
  const fallback = buildFallbackCatalog();
  const [plan, packs] = await Promise.all([findPublishedPlan(), findPublishedTopupPacks()]);
  if (!plan) return fallback;
  const tokensPerCredit = Math.max(1, Number(plan.tokensPerCredit || fallback.tokensPerCredit));
  return {
    planKey: String(plan.planKey || fallback.planKey),
    planName: String(plan.name || fallback.planName),
    description: String(plan.description || ""),
    currency: String(plan.currency || fallback.currency),
    monthlyPrice: Math.max(0, Number(plan.monthlyPrice || 0)),
    includedCredits: Math.max(0, Number(plan.includedCredits || 0)),
    tokensPerCredit,
    includedTokens: creditsToTokens(plan.includedCredits, tokensPerCredit),
    durationDays: Math.max(1, Number(plan.durationDays || fallback.durationDays)),
    limits: {
      ...normalizeAiLimits(plan.limits, fallback.limits),
    },
    renewalPolicy: {
      ...serializeRenewalPolicy(plan.renewalPolicy),
    },
    topupPacks: packs.length
      ? packs.map((item) => ({
          packId: String(item.packId),
          label: String(item.label),
          description: String(item.description || ""),
          credits: Math.max(1, Number(item.credits || 0)),
          price: Math.max(0, Number(item.price || 0)),
          currency: String(item.currency || "INR"),
          sortOrder: Math.max(0, Number(item.sortOrder || 0)),
          featured: Boolean(item.featured),
        }))
      : fallback.topupPacks,
    source: "database",
    planId: String(plan._id),
  };
}

async function resolveAiAddonAccess({ workspaceId, workspace = null, activeSubscription = null } = {}) {
  const resolvedWorkspace = workspace || (await Workspace.findById(workspaceId).lean());
  if (!resolvedWorkspace) {
    throw new HttpError(404, "Workspace not found");
  }
  if (String(resolvedWorkspace.status || "active") !== "active" || resolvedWorkspace.isActive === false) {
    return {
      workspace: resolvedWorkspace,
      entitlements: null,
      featureAccess: {
        allowed: false,
        reason: "workspace_blocked",
      },
      purchase: {
        allowed: false,
        reason: "workspace_blocked",
      },
    };
  }
  const entitlements = await getWorkspaceEntitlements(workspaceId);
  const featureAllowed = Boolean(entitlements?.features?.aiAgentsPageAccess);
  const featureReason = featureAllowed ? null : String(entitlements?.plan || "").toLowerCase() === "free" ? "plan_upgrade_required" : "feature_disabled";
  const hasActiveAddon = Boolean(activeSubscription && activeSubscription.status === "active");
  return {
    workspace: resolvedWorkspace,
    entitlements,
    featureAccess: {
      allowed: featureAllowed,
      reason: featureReason,
    },
    purchase: {
      allowed: featureAllowed && !hasActiveAddon,
      reason: !featureAllowed ? featureReason : hasActiveAddon ? "already_active" : null,
    },
  };
}

async function expireSubscriptionIfNeeded(subscription) {
  if (!subscription || subscription.status !== "active") return subscription;
  const renewalDate = subscription.renewalDate ? new Date(subscription.renewalDate) : null;
  if (!renewalDate || renewalDate > new Date()) return subscription;
  const expired = await AiSubscription.findByIdAndUpdate(
    subscription._id,
    {
      $set: {
        status: "expired",
        expiredAt: new Date(),
        remainingIncludedTokens: 0,
        remainingTopupTokens: 0,
        remainingCredits: 0,
        remainingTokens: 0,
        totalCredits: 0,
      },
    },
    { new: true }
  );
  await syncWorkspaceAddonState({ workspaceId: subscription.workspaceId, subscription: null });
  return expired;
}

async function findCurrentSubscription(workspaceId) {
  if (!mongoose.Types.ObjectId.isValid(String(workspaceId || ""))) return null;
  const subscription = await AiSubscription.findOne({ workspaceId, status: "active" }).sort({ createdAt: -1 }).lean(false);
  if (!subscription) return null;
  const checked = await expireSubscriptionIfNeeded(subscription);
  return checked?.status === "active" ? checked : null;
}

function serializeSubscription(subscription) {
  if (!subscription) return null;
  const value = typeof subscription.toObject === "function" ? subscription.toObject() : subscription;
  const snapshot = balanceSnapshot(value);
  return {
    id: String(value._id),
    workspaceId: String(value.workspaceId),
    userId: String(value.userId),
    planKey: value.planKey,
    planName: value.planName,
    status: value.status,
    currency: value.currency || "INR",
    monthlyPrice: Number(value.monthlyPrice || 0),
    includedCredits: Number(value.includedCredits || 0),
    includedTokensPerCycle: Number(value.includedTokensPerCycle || 0),
    remainingIncludedTokens: snapshot.remainingIncludedTokens,
    remainingIncludedCredits: snapshot.remainingIncludedCredits,
    totalTopupCredits: Number(value.totalTopupCredits || 0),
    remainingTopupTokens: snapshot.remainingTopupTokens,
    remainingTopupCredits: snapshot.remainingTopupCredits,
    totalCredits: snapshot.totalCredits,
    remainingCredits: snapshot.remainingCredits,
    remainingTokens: snapshot.remainingTokens,
    tokensPerCredit: Number(value.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT),
    lastResetAt: value.lastResetAt || null,
    activatedAt: value.activatedAt || null,
    renewalDate: value.renewalDate || null,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
    metadata: value.metadata || {},
  };
}

function serializeTransaction(row) {
  if (!row) return null;
  const value = typeof row.toObject === "function" ? row.toObject() : row;
  return {
    id: String(value._id),
    workspaceId: String(value.workspaceId),
    subscriptionId: value.subscriptionId ? String(value.subscriptionId) : null,
    userId: value.userId ? String(value.userId) : null,
    executionKey: value.executionKey || null,
    type: value.type,
    entryType: value.entryType || normalizeLedgerEntryType(value.type, "", value.metadata || {}),
    source: value.source || "",
    reason: value.reason || "",
    reference: value.reference || "",
    conversationId: value.conversationId ? String(value.conversationId) : null,
    agentId: value.agentId ? String(value.agentId) : null,
    actor: {
      actorType: value.actor?.actorType || "system",
      actorId: value.actor?.actorId ? String(value.actor.actorId) : null,
      actorName: value.actor?.actorName || "",
    },
    direction: value.direction,
    credits: Number(value.credits || 0),
    tokens: Number(value.tokens || 0),
    amount: Number(value.amount || 0),
    currency: value.currency || "INR",
    description: value.description || "",
    balanceAfter: {
      remainingCredits: Number(value.balanceAfter?.remainingCredits || 0),
      remainingTokens: Number(value.balanceAfter?.remainingTokens || 0),
      remainingIncludedTokens: Number(value.balanceAfter?.remainingIncludedTokens || 0),
      remainingTopupTokens: Number(value.balanceAfter?.remainingTopupTokens || 0),
      remainingIncludedCredits: Number(value.balanceAfter?.remainingIncludedCredits || 0),
      remainingTopupCredits: Number(value.balanceAfter?.remainingTopupCredits || 0),
    },
    metadata: value.metadata || {},
    createdAt: value.createdAt || null,
  };
}

async function listCreditTransactions({ workspaceId, limit = 20, cursor = null, filters = {} }) {
  const normalizedLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  const query = { workspaceId };
  if (cursor && mongoose.Types.ObjectId.isValid(String(cursor))) {
    query._id = { $lt: cursor };
  }
  if (filters?.dateFrom || filters?.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
    if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
  }
  if (filters?.type) query.type = String(filters.type);
  if (filters?.entryType) query.entryType = String(filters.entryType);
  if (filters?.source) query.source = String(filters.source);
  if (filters?.agentId && mongoose.Types.ObjectId.isValid(String(filters.agentId))) {
    query.agentId = filters.agentId;
  }
  if (filters?.conversationId && mongoose.Types.ObjectId.isValid(String(filters.conversationId))) {
    query.conversationId = filters.conversationId;
  }
  if (filters?.search) {
    const regex = new RegExp(String(filters.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ executionKey: regex }, { description: regex }, { reason: regex }, { reference: regex }];
  }
  const rows = await AiCreditTransaction.find(query).sort({ _id: -1 }).limit(normalizedLimit + 1);
  const hasMore = rows.length > normalizedLimit;
  const page = hasMore ? rows.slice(0, normalizedLimit) : rows;
  return {
    success: true,
    transactions: page.map(serializeTransaction),
    nextCursor: hasMore ? String(page[page.length - 1]?._id || "") : null,
  };
}

async function getAddonStatus({ workspaceId }) {
  const [workspace, subscription, wallet, catalog] = await Promise.all([
    Workspace.findById(workspaceId).lean(),
    findCurrentSubscription(workspaceId),
    walletCoreService.getOrCreateWallet(workspaceId),
    getCatalogConfig(),
  ]);
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const accessState = await resolveAiAddonAccess({
    workspaceId,
    workspace,
    activeSubscription: subscription,
  });

  const activeSubscription = subscription && subscription.status === "active" ? subscription : null;
  if (!activeSubscription && workspace.aiAgentEnabled) {
    await syncWorkspaceAddonState({ workspaceId, subscription: null });
  } else if (activeSubscription) {
    await syncWorkspaceAddonState({ workspaceId, subscription: activeSubscription });
  }

  return {
    success: true,
    access: {
      enabled: Boolean(activeSubscription),
      reason: activeSubscription ? null : accessState.featureAccess.allowed ? "purchase_required" : accessState.featureAccess.reason,
    },
    featureAccess: accessState.featureAccess,
    purchase: accessState.purchase,
    catalog,
    subscription: serializeSubscription(activeSubscription),
    workspace: {
      id: String(workspace._id),
      aiAgentEnabled: Boolean(activeSubscription),
      aiSubscriptionId: activeSubscription ? String(activeSubscription._id) : null,
      includedCredits: activeSubscription ? tokensToVisibleCredits(Number(activeSubscription.includedTokensPerCycle || 0), Number(activeSubscription.tokensPerCredit || catalog.tokensPerCredit)) : 0,
      remainingIncludedCredits: activeSubscription ? tokensToVisibleCredits(Number(activeSubscription.remainingIncludedTokens || 0), Number(activeSubscription.tokensPerCredit || catalog.tokensPerCredit)) : 0,
      totalCredits: activeSubscription ? balanceSnapshot(activeSubscription).totalCredits : 0,
      remainingCredits: activeSubscription ? balanceSnapshot(activeSubscription).remainingCredits : 0,
      remainingTokens: activeSubscription ? balanceSnapshot(activeSubscription).remainingTokens : 0,
      remainingTopupCredits: activeSubscription ? tokensToVisibleCredits(Number(activeSubscription.remainingTopupTokens || 0), Number(activeSubscription.tokensPerCredit || catalog.tokensPerCredit)) : 0,
      renewalDate: activeSubscription?.renewalDate || null,
      activatedAt: activeSubscription?.activatedAt || null,
      limits: activeSubscription?.metadata?.limits || catalog.limits,
      renewalPolicy: serializeRenewalPolicy(activeSubscription?.metadata?.renewalPolicy || catalog.renewalPolicy),
    },
    wallet: {
      balance: Number(wallet?.balance || 0),
      currency: wallet?.currency || "INR",
    },
  };
}

async function assertAiAddonAccess(workspaceId) {
  const subscription = await findCurrentSubscription(workspaceId);
  if (!subscription) {
    throw new HttpError(403, "AI Agent add-on is not active for this workspace.", { code: "AI_ADDON_REQUIRED" });
  }
  return subscription;
}

async function getWorkspaceAiLimits(workspaceId, { requireActive = true } = {}) {
  const fallback = buildFallbackCatalog();
  const subscription = await findCurrentSubscription(workspaceId);
  if (subscription?.status === "active") {
    return normalizeAiLimits(subscription.metadata?.limits, fallback.limits);
  }
  if (requireActive) {
    throw new HttpError(403, "AI Agent add-on is not active for this workspace.", {
      code: "AI_ADDON_REQUIRED",
    });
  }
  const catalog = await getCatalogConfig();
  return normalizeAiLimits(catalog.limits, fallback.limits);
}

async function createOrReplaceWorkspaceSubscription({
  workspaceId,
  userId,
  catalog,
  source = "purchase",
  chargeAmount = 0,
  preserveTopupTokens = false,
  existingSubscription = null,
}) {
  const now = new Date();
  const renewalDate = new Date(now.getTime() + Number(catalog.durationDays || AI_AGENT_ADDON_DURATION_DAYS) * 24 * 60 * 60 * 1000);
  const previous = existingSubscription || (await findCurrentSubscription(workspaceId));
  const remainingTopupTokens = preserveTopupTokens ? Math.max(0, Number(previous?.remainingTopupTokens || 0)) : 0;
  const totalTopupCredits = preserveTopupTokens ? Math.max(0, Number(previous?.totalTopupCredits || 0)) : 0;
  if (previous) {
    await AiSubscription.updateMany(
      { workspaceId, status: "active" },
      { $set: { status: "cancelled", cancelledAt: now } }
    );
  }
  const includedTokens = creditsToTokens(catalog.includedCredits, catalog.tokensPerCredit);
  const subscription = await AiSubscription.create({
    workspaceId,
    userId,
    planKey: catalog.planKey,
    planName: catalog.planName,
    status: "active",
    currency: catalog.currency,
    monthlyPrice: catalog.monthlyPrice,
    includedCredits: catalog.includedCredits,
    includedTokensPerCycle: includedTokens,
    remainingIncludedTokens: includedTokens,
    totalTopupCredits,
    remainingTopupTokens,
    totalCredits: tokensToVisibleCredits(includedTokens + remainingTopupTokens, catalog.tokensPerCredit),
    remainingCredits: tokensToVisibleCredits(includedTokens + remainingTopupTokens, catalog.tokensPerCredit),
    remainingTokens: includedTokens + remainingTopupTokens,
    tokensPerCredit: catalog.tokensPerCredit,
    lastResetAt: now,
    activatedAt: now,
    renewalDate,
    latestWalletTransactionMeta: {
      chargedAmount: Number(chargeAmount || 0),
      chargedAt: now,
      source,
    },
    metadata: {
      limits: catalog.limits,
      renewalPolicy: catalog.renewalPolicy,
      catalogSource: catalog.source || source,
      planId: catalog.planId || null,
    },
  });
  await syncWorkspaceAddonState({ workspaceId, subscription });
  return subscription;
}

async function purchaseAddon({ workspaceId, userId }) {
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");
  const active = await findCurrentSubscription(workspaceId);
  if (active) throw new HttpError(409, "AI Agent add-on is already active for this workspace.");
  const accessState = await resolveAiAddonAccess({
    workspaceId,
    workspace,
    activeSubscription: active,
  });
  if (!accessState.featureAccess.allowed) {
    throw new HttpError(403, "Upgrade your plan to purchase the AI Agent add-on.", {
      code: "AI_ADDON_PLAN_UPGRADE_REQUIRED",
      reason: accessState.featureAccess.reason,
    });
  }

  const catalog = await getCatalogConfig();
  await walletCoreService.debit(workspaceId, catalog.monthlyPrice, "AI Agent add-on purchase", {
    billingKind: "ai_agent_addon_purchase",
    planKey: catalog.planKey,
  });

  const subscription = await createOrReplaceWorkspaceSubscription({
    workspaceId,
    userId,
    catalog,
    source: "wallet",
    chargeAmount: catalog.monthlyPrice,
  });

  await createCreditTransaction({
    workspaceId,
    subscription,
    userId,
    type: "purchase",
    entryType: "included_credit_allocation",
    source: "subscription_purchase",
    reason: "workspace_addon_activation",
    actor: { actorType: "workspace_user", actorId: userId },
    direction: "credit",
    credits: catalog.includedCredits,
    tokens: catalog.includedTokens,
    amount: catalog.monthlyPrice,
    currency: catalog.currency,
    description: "AI Agent add-on activated",
    metadata: { planKey: catalog.planKey, planId: catalog.planId || null, source: "subscription_purchase" },
  });

  return {
    ...(await getAddonStatus({ workspaceId })),
    message: "AI Agent add-on activated successfully.",
  };
}

async function purchaseTopup({ workspaceId, userId, packId }) {
  const subscription = await assertAiAddonAccess(workspaceId);
  const catalog = await getCatalogConfig();
  const pack = (catalog.topupPacks || []).find((item) => item.packId === String(packId || ""));
  if (!pack) throw new HttpError(404, "AI top-up pack not found.");

  await walletCoreService.debit(workspaceId, pack.price, `AI credits top-up (${pack.label})`, {
    billingKind: "ai_agent_topup_purchase",
    packId: pack.packId,
    credits: pack.credits,
  });

  const tokensPerCredit = Number(subscription.tokensPerCredit || catalog.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT);
  const nextRemainingTopupTokens = Math.max(0, Number(subscription.remainingTopupTokens || 0)) + creditsToTokens(pack.credits, tokensPerCredit);
  const nextTotalTopupCredits = Math.max(0, Number(subscription.totalTopupCredits || 0)) + Number(pack.credits || 0);
  const updated = await AiSubscription.findByIdAndUpdate(
    subscription._id,
    {
      $set: {
        remainingTopupTokens: nextRemainingTopupTokens,
        totalTopupCredits: nextTotalTopupCredits,
        remainingTokens: Math.max(0, Number(subscription.remainingIncludedTokens || 0)) + nextRemainingTopupTokens,
        remainingCredits: tokensToVisibleCredits(Math.max(0, Number(subscription.remainingIncludedTokens || 0)) + nextRemainingTopupTokens, tokensPerCredit),
        totalCredits: tokensToVisibleCredits(Math.max(0, Number(subscription.includedTokensPerCycle || 0)) + nextRemainingTopupTokens, tokensPerCredit),
      },
    },
    { new: true }
  );

  await syncWorkspaceAddonState({ workspaceId, subscription: updated });
  await createCreditTransaction({
    workspaceId,
    subscription: updated,
    userId,
    type: "topup_purchase",
    entryType: "topup_purchase",
    source: "wallet_topup_purchase",
    reason: "workspace_topup_purchase",
    actor: { actorType: "workspace_user", actorId: userId },
    direction: "credit",
    credits: pack.credits,
    tokens: creditsToTokens(pack.credits, tokensPerCredit),
    amount: pack.price,
    currency: subscription.currency || "INR",
    description: `Top-up purchased: ${pack.label}`,
    metadata: { packId: pack.packId, packLabel: pack.label, source: "wallet_topup_purchase" },
  });

  return {
    ...(await getAddonStatus({ workspaceId })),
    message: "AI credits added successfully.",
  };
}

async function applyAdjustment({
  workspaceId,
  userId,
  type,
  credits,
  reason,
  reference = "",
  source = "",
  actor = null,
  entryType = "",
}) {
  const subscription = await assertAiAddonAccess(workspaceId);
  const baseType = type === "refund" ? "refund" : "adjustment";
  const ledgerEntryType = type === "refund" ? "refund" : entryType || "manual_adjustment";
  const numericCredits = Number(credits || 0);
  if (!Number.isFinite(numericCredits) || numericCredits === 0) {
    throw new HttpError(400, "Credits must be a non-zero number.");
  }
  const tokenDelta = Math.abs(creditsToTokens(Math.abs(numericCredits), Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)));
  const currentIncluded = Math.max(0, Number(subscription.remainingIncludedTokens || 0));
  const currentTopup = Math.max(0, Number(subscription.remainingTopupTokens || 0));
  let nextIncluded = currentIncluded;
  let nextTopup = currentTopup;

  if (numericCredits > 0) {
    nextTopup += tokenDelta;
  } else {
    let remainingToDeduct = tokenDelta;
    const topupDeduct = Math.min(nextTopup, remainingToDeduct);
    nextTopup -= topupDeduct;
    remainingToDeduct -= topupDeduct;
    if (remainingToDeduct > nextIncluded) {
      throw new HttpError(402, "Not enough AI credits available for this adjustment.");
    }
    nextIncluded -= remainingToDeduct;
  }

  const updated = await AiSubscription.findByIdAndUpdate(
    subscription._id,
    {
      $set: {
        remainingIncludedTokens: nextIncluded,
        remainingTopupTokens: nextTopup,
        remainingTokens: nextIncluded + nextTopup,
        remainingCredits: tokensToVisibleCredits(nextIncluded + nextTopup, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
        totalCredits: tokensToVisibleCredits(Math.max(0, Number(subscription.includedTokensPerCycle || 0)) + nextTopup, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
      },
    },
    { new: true }
  );

  await syncWorkspaceAddonState({ workspaceId, subscription: updated });
  await createCreditTransaction({
    workspaceId,
    subscription: updated,
    userId,
    type: baseType,
    entryType: ledgerEntryType,
    source: String(source || (baseType === "refund" ? "admin_refund" : "manual_adjustment")).trim(),
    reason: String(reason || "").trim(),
    reference: String(reference || "").trim(),
    actor: actor || { actorType: userId ? "workspace_user" : "system", actorId: userId || null },
    direction: numericCredits > 0 ? "credit" : "debit",
    credits: Math.abs(numericCredits),
    tokens: tokenDelta,
    amount: 0,
    currency: subscription.currency || "INR",
    description: reason || (baseType === "refund" ? "AI credit refund" : "AI credit adjustment"),
    metadata: { requestedCredits: numericCredits, source: String(source || ""), reason: String(reason || ""), reference: String(reference || "") },
  });

  return {
    ...(await getAddonStatus({ workspaceId })),
    message: `${baseType === "refund" ? "Refund" : "Adjustment"} applied successfully.`,
  };
}

async function consumeIncludedCredits({ workspaceId, creditsUsed = 0, meta = {} }) {
  const subscription = await assertAiAddonAccess(workspaceId);
  const executionKey = String(meta.executionKey || "").trim() || null;
  if (executionKey) {
    const existing = await AiCreditTransaction.findOne({
      workspaceId,
      executionKey,
      type: "usage",
      direction: "debit",
    }).lean();
    if (existing) {
      return {
        enabled: true,
        deducted: false,
        idempotent: true,
        creditsUsed: Number(existing.credits || 0),
        remainingCredits: Number(existing.balanceAfter?.remainingCredits || 0),
        remainingTokens: Number(existing.balanceAfter?.remainingTokens || 0),
        currency: existing.currency || subscription.currency || "INR",
        transactionId: existing._id ? String(existing._id) : null,
      };
    }
  }
  const totalTokens = Math.max(0, Math.ceil(Number(meta.totalTokens || Number(meta.inputTokens || 0) + Number(meta.outputTokens || 0) || 0)));
  const fallbackTokens = creditsToTokens(Math.max(0, Number(creditsUsed || 0)), Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT));
  const tokensToDeduct = totalTokens || fallbackTokens;
  if (!tokensToDeduct) {
    const snapshot = balanceSnapshot(subscription);
    return {
      enabled: true,
      deducted: false,
      creditsUsed: 0,
      remainingCredits: snapshot.remainingCredits,
      remainingTokens: snapshot.remainingTokens,
      currency: subscription.currency || "INR",
    };
  }

  const currentIncluded = Math.max(0, Number(subscription.remainingIncludedTokens || 0));
  const currentTopup = Math.max(0, Number(subscription.remainingTopupTokens || 0));
  if (currentIncluded + currentTopup < tokensToDeduct) {
    throw new HttpError(402, "AI credits exhausted. Renew or top up your AI add-on.");
  }

  const deductFromIncluded = Math.min(currentIncluded, tokensToDeduct);
  const deductFromTopup = Math.max(0, tokensToDeduct - deductFromIncluded);
  const nextIncluded = currentIncluded - deductFromIncluded;
  const nextTopup = currentTopup - deductFromTopup;

  const updated = await AiSubscription.findOneAndUpdate(
    {
      _id: subscription._id,
      status: "active",
      $expr: {
        $gte: [
          { $add: [{ $ifNull: ["$remainingIncludedTokens", 0] }, { $ifNull: ["$remainingTopupTokens", 0] }] },
          tokensToDeduct,
        ],
      },
    },
    {
      $set: {
        remainingIncludedTokens: nextIncluded,
        remainingTopupTokens: nextTopup,
        remainingTokens: nextIncluded + nextTopup,
        remainingCredits: tokensToVisibleCredits(nextIncluded + nextTopup, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
        totalCredits: tokensToVisibleCredits(Math.max(0, Number(subscription.includedTokensPerCycle || 0)) + nextTopup, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
        metadata: {
          ...(subscription.metadata || {}),
          lastUsageAt: new Date(),
          lastUsageMeta: meta,
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    throw new HttpError(409, "AI credits changed during processing. Please try again.");
  }

  await syncWorkspaceAddonState({ workspaceId, subscription: updated });
  await createCreditTransaction({
    workspaceId,
    subscription: updated,
    userId: null,
    executionKey,
    type: "usage",
    entryType: deductFromTopup > 0 ? "topup_usage" : "included_credit_usage",
    source: "runtime_execution",
    reason: "ai_runtime_usage",
    actor: { actorType: "runtime" },
    direction: "debit",
    credits: tokensToCreditsExact(tokensToDeduct, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
    tokens: tokensToDeduct,
    amount: 0,
    currency: subscription.currency || "INR",
    description: "AI runtime usage",
    conversationId: meta?.conversationId || null,
    agentId: meta?.agentId || null,
    metadata: {
      ...meta,
      source: "runtime_execution",
      breakdown: {
        includedTokensUsed: deductFromIncluded,
        topupTokensUsed: deductFromTopup,
        includedCreditsUsed: tokensToCreditsExact(deductFromIncluded, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
        topupCreditsUsed: tokensToCreditsExact(deductFromTopup, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
      },
    },
  });

  const snapshot = balanceSnapshot(updated);
  return {
    enabled: true,
    deducted: true,
    creditsUsed: tokensToCreditsExact(tokensToDeduct, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
    remainingCredits: snapshot.remainingCredits,
    remainingTokens: snapshot.remainingTokens,
    currency: updated.currency || "INR",
    transactionId: null,
  };
}

async function processAiSubscriptionRenewals({ now = new Date(), limit = 100 } = {}) {
  const due = await AiSubscription.find({ status: "active", renewalDate: { $lte: now } })
    .sort({ renewalDate: 1 })
    .limit(Math.max(1, Number(limit || 100)))
    .lean(false);

  let processed = 0;
  let renewed = 0;
  let expired = 0;
  for (const subscription of due) {
    processed += 1;
    const renewalMode = String(subscription.metadata?.renewalPolicy?.mode || "auto_renew");
    if (renewalMode !== "auto_renew") {
      const unusedIncludedTokens = Math.max(0, Number(subscription.remainingIncludedTokens || 0));
      await AiSubscription.findByIdAndUpdate(subscription._id, { $set: { status: "expired", expiredAt: now } }, { new: true });
      await syncWorkspaceAddonState({ workspaceId: subscription.workspaceId, subscription: null });
      if (unusedIncludedTokens > 0) {
        await createCreditTransaction({
          workspaceId: subscription.workspaceId,
          subscription,
          userId: subscription.userId || null,
          type: "adjustment",
          entryType: "credit_expiry",
          source: "subscription_expiry",
          reason: "unused_included_credits_expired",
          actor: { actorType: "system", actorId: subscription.userId || null },
          direction: "debit",
          credits: tokensToCreditsExact(unusedIncludedTokens, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
          tokens: unusedIncludedTokens,
          amount: 0,
          currency: subscription.currency || "INR",
          description: "Unused included credits expired",
          metadata: { source: "subscription_expiry" },
        });
      }
      expired += 1;
      continue;
    }
    try {
      await walletCoreService.debit(subscription.workspaceId, Number(subscription.monthlyPrice || 0), "AI Agent add-on renewal", {
        billingKind: "ai_agent_addon_renewal",
        subscriptionId: String(subscription._id),
      });
      const nextRenewalDate = new Date(now.getTime() + AI_AGENT_ADDON_DURATION_DAYS * 24 * 60 * 60 * 1000);
      const includeTokens = Number(subscription.includedTokensPerCycle || creditsToTokens(subscription.includedCredits || AI_AGENT_ADDON_INCLUDED_CREDITS, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)));
      const preservedTopupTokens = Math.max(0, Number(subscription.remainingTopupTokens || 0));
      const expiredIncludedTokens = Math.max(0, Number(subscription.remainingIncludedTokens || 0));
      const updated = await AiSubscription.findByIdAndUpdate(
        subscription._id,
        {
          $set: {
            remainingIncludedTokens: includeTokens,
            remainingTopupTokens: preservedTopupTokens,
            remainingTokens: includeTokens + preservedTopupTokens,
            remainingCredits: tokensToVisibleCredits(includeTokens + preservedTopupTokens, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
            totalCredits: tokensToVisibleCredits(includeTokens + preservedTopupTokens, Number(subscription.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
            renewalDate: nextRenewalDate,
            lastResetAt: now,
            activatedAt: now,
            expiredAt: null,
            latestWalletTransactionMeta: {
              chargedAmount: Number(subscription.monthlyPrice || 0),
              chargedAt: now,
              source: "wallet",
              renewal: true,
            },
            metadata: {
              ...(subscription.metadata || {}),
              renewalPolicy: serializeRenewalPolicy(subscription.metadata?.renewalPolicy),
            },
          },
        },
        { new: true }
      );
      await syncWorkspaceAddonState({ workspaceId: updated.workspaceId, subscription: updated });
      if (expiredIncludedTokens > 0) {
        await createCreditTransaction({
          workspaceId: updated.workspaceId,
          subscription: updated,
          userId: updated.userId || null,
          type: "adjustment",
          entryType: "credit_expiry",
          source: "renewal_expiry",
          reason: "unused_included_credits_expired",
          actor: { actorType: "system", actorId: updated.userId || null },
          direction: "debit",
          credits: tokensToCreditsExact(expiredIncludedTokens, Number(updated.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
          tokens: expiredIncludedTokens,
          amount: 0,
          currency: updated.currency || "INR",
          description: "Unused included credits expired at renewal",
          metadata: { renewalDate: nextRenewalDate, source: "renewal_expiry" },
        });
      }
      await createCreditTransaction({
        workspaceId: updated.workspaceId,
        subscription: updated,
        userId: updated.userId || null,
        type: "monthly_reset",
        entryType: "subscription_reset",
        source: "subscription_renewal",
        reason: "monthly_included_credit_reset",
        actor: { actorType: "system", actorId: updated.userId || null },
        direction: "credit",
        credits: tokensToVisibleCredits(Number(updated.includedTokensPerCycle || 0), Number(updated.tokensPerCredit || AI_AGENT_TOKENS_PER_CREDIT)),
        tokens: Number(updated.includedTokensPerCycle || 0),
        amount: Number(updated.monthlyPrice || 0),
        currency: updated.currency || "INR",
        description: "Monthly AI credits renewed",
        metadata: { renewalDate: nextRenewalDate, source: "subscription_renewal" },
      });
      renewed += 1;
    } catch (error) {
      const updated = await AiSubscription.findByIdAndUpdate(
        subscription._id,
        {
          $set: {
            status: "expired",
            expiredAt: now,
            remainingIncludedTokens: 0,
            remainingTopupTokens: 0,
            remainingTokens: 0,
            remainingCredits: 0,
            totalCredits: 0,
          },
        },
        { new: true }
      );
      await syncWorkspaceAddonState({ workspaceId: subscription.workspaceId, subscription: null });
      await createCreditTransaction({
        workspaceId: subscription.workspaceId,
        subscription: updated,
        userId: subscription.userId || null,
        type: "adjustment",
        entryType: "manual_adjustment",
        source: "renewal_failure_expiry",
        reason: "renewal_payment_failed",
        actor: { actorType: "system", actorId: subscription.userId || null },
        direction: "debit",
        credits: 0,
        tokens: 0,
        amount: 0,
        currency: subscription.currency || "INR",
        description: "AI subscription expired after renewal failure",
        metadata: { error: error?.message || "renewal_failed", source: "renewal_failure_expiry" },
      });
      expired += 1;
    }
  }
  return { processed, renewed, expired };
}

module.exports = {
  AI_AGENT_TOKENS_PER_CREDIT,
  AI_AGENT_ADDON_PLAN_KEY,
  assertAiAddonAccess,
  buildCatalog: buildFallbackCatalog,
  getWorkspaceAiLimits,
  consumeIncludedCredits,
  createCreditTransaction,
  createOrReplaceWorkspaceSubscription,
  creditsToTokens,
  findCurrentSubscription,
  getAddonStatus,
  getCatalogConfig,
  normalizeAiLimits,
  listCreditTransactions,
  processAiSubscriptionRenewals,
  purchaseAddon,
  purchaseTopup,
  resolveAiAddonAccess,
  serializeSubscription,
  serializeTransaction,
  syncWorkspaceAddonState,
  tokensToCreditsExact,
  tokensToVisibleCredits,
  applyAdjustment,
};
