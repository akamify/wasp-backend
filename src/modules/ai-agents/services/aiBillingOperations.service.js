const mongoose = require("mongoose");
const { AiAgent } = require("@infra/database/AiAgent");
const { AiBudgetConfig } = require("@infra/database/AiBudgetConfig");
const { AiBillingStatement } = require("@infra/database/AiBillingStatement");
const { AiConversation } = require("@infra/database/AiConversation");
const { AiCreditTransaction } = require("@infra/database/AiCreditTransaction");
const { AiSubscription } = require("@infra/database/AiSubscription");
const { AiUsageLog } = require("@infra/database/AiUsageLog");
const { Contact } = require("@infra/database/Contact");
const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");
const { HttpError } = require("@shared/utils/httpError");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(String(value))) return null;
  return new mongoose.Types.ObjectId(String(value));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthKey(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) return null;
  return {
    key: raw,
    start: new Date(year, month - 1, 1),
    end: new Date(year, month, 0, 23, 59, 59, 999),
  };
}

function normalizeLimit(value, fallback = 20, max = 100) {
  return Math.min(Math.max(Number(value || fallback) || fallback, 1), max);
}

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function creditsFromTokens(tokens, tokensPerCredit) {
  return aiAddonService.tokensToCreditsExact(Number(tokens || 0), Number(tokensPerCredit || aiAddonService.AI_AGENT_TOKENS_PER_CREDIT));
}

function visibleCreditsFromTokens(tokens, tokensPerCredit) {
  return aiAddonService.tokensToVisibleCredits(Number(tokens || 0), Number(tokensPerCredit || aiAddonService.AI_AGENT_TOKENS_PER_CREDIT));
}

function buildCsv(rows, columns) {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows
    .map((row) => columns.map((column) => csvCell(typeof column.value === "function" ? column.value(row) : row[column.value])).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function normalizeDateRange(query = {}) {
  const preset = String(query.preset || "").trim().toLowerCase();
  const now = new Date();
  if (preset === "today") {
    return { preset, dateFrom: startOfDay(now), dateTo: endOfDay(now) };
  }
  if (preset === "yesterday") {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return { preset, dateFrom: startOfDay(yesterday), dateTo: endOfDay(yesterday) };
  }
  if (preset === "last_7_days") {
    return { preset, dateFrom: startOfDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)), dateTo: endOfDay(now) };
  }
  if (preset === "last_30_days") {
    return { preset, dateFrom: startOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)), dateTo: endOfDay(now) };
  }
  const dateFrom = query.dateFrom ? startOfDay(new Date(query.dateFrom)) : startOfMonth(now);
  const dateTo = query.dateTo ? endOfDay(new Date(query.dateTo)) : endOfDay(now);
  return { preset: preset || "custom", dateFrom, dateTo };
}

function mapLedgerEntryType(row) {
  if (!row) return "";
  if (row.entryType) return String(row.entryType);
  const metadata = row.metadata || {};
  switch (String(row.type || "")) {
    case "purchase":
      return "included_credit_allocation";
    case "monthly_reset":
      return "subscription_reset";
    case "topup_purchase":
      return "topup_purchase";
    case "refund":
      return "refund";
    case "adjustment":
      if (String(metadata?.source || "").includes("migration")) return "migration_adjustment";
      if (String(metadata?.source || "").includes("expiry")) return "credit_expiry";
      return "manual_adjustment";
    case "usage":
      return Number(metadata?.breakdown?.topupTokensUsed || 0) > 0 ? "topup_usage" : "included_credit_usage";
    default:
      return "";
  }
}

function signedCredits(row) {
  const factor = String(row?.direction || "").toLowerCase() === "debit" ? -1 : 1;
  return factor * safeNumber(row?.credits);
}

function signedTokens(row) {
  const factor = String(row?.direction || "").toLowerCase() === "debit" ? -1 : 1;
  return factor * safeNumber(row?.tokens);
}

function timelineLabel(entryType, source) {
  switch (String(entryType || "")) {
    case "included_credit_allocation":
      return "Subscription Purchased";
    case "subscription_reset":
      return "Subscription Renewed";
    case "topup_purchase":
      return "Top-up Purchased";
    case "included_credit_usage":
    case "topup_usage":
      return "Credits Used";
    case "refund":
      return "Credits Refunded";
    case "manual_adjustment":
    case "migration_adjustment":
      return "Credits Adjusted";
    case "credit_expiry":
      return "Included Credits Expired";
    default:
      return source ? String(source).replace(/_/g, " ") : "Billing Event";
  }
}

async function getBudgetDocument(workspaceId) {
  return AiBudgetConfig.findOne({ workspaceId }).lean();
}

async function getCurrentMonthUsage(workspaceId) {
  const now = new Date();
  const rows = await AiUsageLog.aggregate([
    {
      $match: {
        workspaceId,
        createdAt: { $gte: startOfMonth(now), $lte: endOfDay(now) },
      },
    },
    {
      $group: {
        _id: null,
        creditsUsed: { $sum: "$creditsUsed" },
        requests: { $sum: 1 },
      },
    },
  ]);
  return rows[0] || { creditsUsed: 0, requests: 0 };
}

async function buildBudgetStatus(workspaceId) {
  const [budget, addonStatus, monthUsage] = await Promise.all([
    getBudgetDocument(workspaceId),
    aiAddonService.getAddonStatus({ workspaceId }),
    getCurrentMonthUsage(workspaceId),
  ]);
  const config = budget || {
    monthlyCreditBudget: 0,
    monthlyCreditWarning: 0,
    lowCreditWarning: 0,
    nearExhaustionWarning: 0,
    notificationsEnabled: true,
    lastAlertState: {},
  };
  const usedThisMonth = safeNumber(monthUsage.creditsUsed);
  const remainingCredits = safeNumber(addonStatus?.workspace?.remainingCredits);
  const alerts = [];

  if (config.monthlyCreditBudget > 0 && usedThisMonth >= config.monthlyCreditBudget) {
    alerts.push({ code: "monthly_budget_exceeded", severity: "high", message: "Monthly AI credit budget exceeded." });
  } else if (config.monthlyCreditWarning > 0 && usedThisMonth >= config.monthlyCreditWarning) {
    alerts.push({ code: "monthly_budget_warning", severity: "medium", message: "Monthly AI credit warning threshold reached." });
  }

  if (config.lowCreditWarning > 0 && remainingCredits <= config.lowCreditWarning) {
    alerts.push({ code: "low_credit_warning", severity: "medium", message: "Remaining AI credits are below the configured low-credit warning." });
  }

  if (config.nearExhaustionWarning > 0 && remainingCredits <= config.nearExhaustionWarning) {
    alerts.push({ code: "near_exhaustion_warning", severity: "high", message: "Remaining AI credits are near exhaustion." });
  }

  return {
    success: true,
    config: {
      monthlyCreditBudget: safeNumber(config.monthlyCreditBudget),
      monthlyCreditWarning: safeNumber(config.monthlyCreditWarning),
      lowCreditWarning: safeNumber(config.lowCreditWarning),
      nearExhaustionWarning: safeNumber(config.nearExhaustionWarning),
      notificationsEnabled: config.notificationsEnabled !== false,
      updatedAt: config.updatedAt || null,
    },
    status: {
      usedThisMonth,
      remainingCredits,
      alerts,
    },
  };
}

async function upsertBudgetConfig({ workspaceId, actorId, payload = {} }) {
  const update = {
    monthlyCreditBudget: Math.max(0, safeNumber(payload.monthlyCreditBudget)),
    monthlyCreditWarning: Math.max(0, safeNumber(payload.monthlyCreditWarning)),
    lowCreditWarning: Math.max(0, safeNumber(payload.lowCreditWarning)),
    nearExhaustionWarning: Math.max(0, safeNumber(payload.nearExhaustionWarning)),
    notificationsEnabled: payload.notificationsEnabled !== false,
    updatedBy: toObjectId(actorId),
    lastEvaluatedAt: new Date(),
  };
  const existing = await AiBudgetConfig.findOne({ workspaceId });
  if (existing) {
    Object.assign(existing, update);
    await existing.save();
  } else {
    await AiBudgetConfig.create({
      workspaceId,
      ...update,
      createdBy: toObjectId(actorId),
    });
  }
  return buildBudgetStatus(workspaceId);
}

async function buildStatementRecord({ workspaceId, periodKey }) {
  const parsed = parseMonthKey(periodKey);
  if (!parsed) {
    throw new HttpError(400, "Invalid billing period. Use YYYY-MM.");
  }
  const [workspace, subscription, openingTransaction, periodTransactions, usageRows] = await Promise.all([
    Workspace.findById(workspaceId).select("name businessName slug").lean(),
    AiSubscription.findOne({ workspaceId, createdAt: { $lte: parsed.end } }).sort({ createdAt: -1 }).lean(),
    AiCreditTransaction.findOne({ workspaceId, createdAt: { $lt: parsed.start } }).sort({ createdAt: -1 }).lean(),
    AiCreditTransaction.find({ workspaceId, createdAt: { $gte: parsed.start, $lte: parsed.end } }).sort({ createdAt: 1, _id: 1 }).lean(),
    AiUsageLog.aggregate([
      {
        $match: {
          workspaceId,
          createdAt: { $gte: parsed.start, $lte: parsed.end },
        },
      },
      {
        $group: {
          _id: null,
          totalAiRequests: { $sum: 1 },
          totalRuntimeExecutions: { $sum: 1 },
          conversations: { $addToSet: "$conversationId" },
        },
      },
    ]),
  ]);

  const openingCredits = safeNumber(openingTransaction?.balanceAfter?.remainingCredits || 0);
  const openingTokens = safeNumber(openingTransaction?.balanceAfter?.remainingTokens || 0);
  const closingTransaction = periodTransactions[periodTransactions.length - 1] || openingTransaction || null;
  const tokensPerCredit = Number(subscription?.tokensPerCredit || aiAddonService.AI_AGENT_TOKENS_PER_CREDIT);
  const statement = {
    workspaceId,
    subscriptionId: subscription?._id || null,
    periodKey: parsed.key,
    periodStart: parsed.start,
    periodEnd: parsed.end,
    workspaceSnapshot: {
      name: workspace?.name || "",
      businessName: workspace?.businessName || "",
      slug: workspace?.slug || "",
    },
    planSnapshot: {
      subscriptionPlan: subscription?.planKey || "",
      aiAddonPlan: subscription?.planName || "",
      currency: subscription?.currency || "INR",
      tokensPerCredit,
    },
    balances: {
      openingCredits,
      openingTokens,
      includedCreditsAdded: 0,
      includedTokensAdded: 0,
      topupCreditsPurchased: 0,
      topupTokensPurchased: 0,
      creditsConsumed: 0,
      tokensConsumed: 0,
      creditsRefunded: 0,
      tokensRefunded: 0,
      creditsAdjusted: 0,
      tokensAdjusted: 0,
      includedCreditsExpired: 0,
      includedTokensExpired: 0,
      closingCredits: safeNumber(closingTransaction?.balanceAfter?.remainingCredits || openingCredits),
      closingTokens: safeNumber(closingTransaction?.balanceAfter?.remainingTokens || openingTokens),
    },
    activity: {
      totalAiRequests: safeNumber(usageRows[0]?.totalAiRequests),
      totalRuntimeExecutions: safeNumber(usageRows[0]?.totalRuntimeExecutions),
      totalConversationsHandled: Array.isArray(usageRows[0]?.conversations)
        ? usageRows[0].conversations.filter(Boolean).length
        : 0,
    },
  };

  for (const row of periodTransactions) {
    const entryType = mapLedgerEntryType(row);
    if (entryType === "included_credit_allocation" || entryType === "subscription_reset") {
      statement.balances.includedCreditsAdded += safeNumber(row.credits);
      statement.balances.includedTokensAdded += safeNumber(row.tokens);
    } else if (entryType === "topup_purchase") {
      statement.balances.topupCreditsPurchased += safeNumber(row.credits);
      statement.balances.topupTokensPurchased += safeNumber(row.tokens);
    } else if (entryType === "included_credit_usage" || entryType === "topup_usage") {
      statement.balances.creditsConsumed += safeNumber(row.credits);
      statement.balances.tokensConsumed += safeNumber(row.tokens);
    } else if (entryType === "refund") {
      statement.balances.creditsRefunded += safeNumber(row.credits);
      statement.balances.tokensRefunded += safeNumber(row.tokens);
    } else if (entryType === "manual_adjustment" || entryType === "migration_adjustment") {
      statement.balances.creditsAdjusted += signedCredits(row);
      statement.balances.tokensAdjusted += signedTokens(row);
    } else if (entryType === "credit_expiry") {
      statement.balances.includedCreditsExpired += safeNumber(row.credits);
      statement.balances.includedTokensExpired += safeNumber(row.tokens);
    }
  }

  const existing = await AiBillingStatement.findOne({ workspaceId, periodKey: parsed.key });
  if (existing) {
    Object.assign(existing, statement, {
      metadata: {
        transactionCount: periodTransactions.length,
      },
      reconciledAt: new Date(),
    });
    await existing.save();
    return existing.toObject();
  }

  const created = await AiBillingStatement.create({
    ...statement,
    metadata: {
      transactionCount: periodTransactions.length,
    },
    reconciledAt: new Date(),
  });
  return created.toObject();
}

function serializeStatement(row) {
  return {
    id: row?._id ? String(row._id) : `${row.workspaceId}-${row.periodKey}`,
    workspaceId: String(row.workspaceId),
    subscriptionId: row.subscriptionId ? String(row.subscriptionId) : null,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    workspace: row.workspaceSnapshot || {},
    plan: row.planSnapshot || {},
    balances: row.balances || {},
    activity: row.activity || {},
    reconciledAt: row.reconciledAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function listBillingStatements({ workspaceId, query = {} }) {
  const page = Math.max(1, safeNumber(query.page, 1));
  const limit = normalizeLimit(query.limit, 6, 24);
  const months = [];
  if (query.period) {
    months.push(String(query.period));
  } else {
    const cursor = new Date();
    cursor.setMonth(cursor.getMonth() - (page - 1) * limit);
    for (let index = 0; index < limit; index += 1) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth() - index, 1);
      months.push(monthKey(date));
    }
  }
  const items = [];
  for (const periodKey of months) {
    items.push(serializeStatement(await buildStatementRecord({ workspaceId, periodKey })));
  }
  return {
    success: true,
    items,
    page,
    limit,
  };
}

async function getBillingStatement({ workspaceId, periodKey }) {
  return {
    success: true,
    item: serializeStatement(await buildStatementRecord({ workspaceId, periodKey })),
  };
}

async function downloadBillingStatementCsv({ workspaceId, periodKey }) {
  const statement = serializeStatement(await buildStatementRecord({ workspaceId, periodKey }));
  const rows = [
    { metric: "Period", value: statement.periodKey },
    { metric: "Workspace", value: statement.workspace?.name || statement.workspace?.businessName || statement.workspace?.slug || workspaceId },
    { metric: "Opening Balance Credits", value: statement.balances.openingCredits },
    { metric: "Included Credits Added", value: statement.balances.includedCreditsAdded },
    { metric: "Top-up Credits Purchased", value: statement.balances.topupCreditsPurchased },
    { metric: "Credits Consumed", value: statement.balances.creditsConsumed },
    { metric: "Credits Refunded", value: statement.balances.creditsRefunded },
    { metric: "Credits Adjusted", value: statement.balances.creditsAdjusted },
    { metric: "Included Credits Expired", value: statement.balances.includedCreditsExpired },
    { metric: "Closing Balance Credits", value: statement.balances.closingCredits },
    { metric: "Total AI Requests", value: statement.activity.totalAiRequests },
    { metric: "Total Runtime Executions", value: statement.activity.totalRuntimeExecutions },
    { metric: "Total Conversations Handled", value: statement.activity.totalConversationsHandled },
  ];
  return {
    filename: `ai-billing-statement-${periodKey}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(rows, [
      { label: "Metric", value: "metric" },
      { label: "Value", value: "value" },
    ]),
  };
}

async function getBillingSummary({ workspaceId, query = {} }) {
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);
  const [addonStatus, budgetStatus, trendRows, usageRows, transactionRows] = await Promise.all([
    aiAddonService.getAddonStatus({ workspaceId }),
    buildBudgetStatus(workspaceId),
    AiUsageLog.aggregate([
      {
        $match: {
          workspaceId,
          createdAt: { $gte: startOfDay(new Date(Date.now() - 13 * 24 * 60 * 60 * 1000)), $lte: endOfDay(new Date()) },
        },
      },
      {
        $project: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          creditsUsed: 1,
          requests: 1,
        },
      },
      {
        $group: {
          _id: "$day",
          creditsUsed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    AiUsageLog.aggregate([
      {
        $match: {
          workspaceId,
          createdAt: { $gte: dateFrom, $lte: dateTo },
        },
      },
      {
        $group: {
          _id: null,
          creditsUsed: { $sum: "$creditsUsed" },
          totalRequests: { $sum: 1 },
          conversations: { $addToSet: "$conversationId" },
        },
      },
    ]),
    AiCreditTransaction.find({
      workspaceId,
      createdAt: { $gte: startOfMonth(new Date()), $lte: endOfDay(new Date()) },
    }).lean(),
  ]);

  const usage = usageRows[0] || {};
  const monthlyPurchased = transactionRows
    .filter((row) => mapLedgerEntryType(row) === "topup_purchase")
    .reduce((sum, row) => sum + safeNumber(row.credits), 0);
  const monthlyExpired = transactionRows
    .filter((row) => mapLedgerEntryType(row) === "credit_expiry")
    .reduce((sum, row) => sum + safeNumber(row.credits), 0);
  const monthlyRefunded = transactionRows
    .filter((row) => mapLedgerEntryType(row) === "refund")
    .reduce((sum, row) => sum + safeNumber(row.credits), 0);
  const monthlyAdjusted = transactionRows
    .filter((row) => ["manual_adjustment", "migration_adjustment"].includes(mapLedgerEntryType(row)))
    .reduce((sum, row) => sum + signedCredits(row), 0);
  const avgCreditsPerRequest = safeNumber(usage.creditsUsed) && safeNumber(usage.totalRequests)
    ? Number((safeNumber(usage.creditsUsed) / safeNumber(usage.totalRequests)).toFixed(3))
    : 0;
  const estimatedRemainingRuntime = avgCreditsPerRequest > 0
    ? Math.floor(safeNumber(addonStatus?.workspace?.remainingCredits) / avgCreditsPerRequest)
    : null;

  return {
    success: true,
    range: {
      preset,
      dateFrom,
      dateTo,
    },
    currentPlan: {
      planKey: addonStatus?.subscription?.planKey || addonStatus?.catalog?.planKey || "",
      planName: addonStatus?.subscription?.planName || addonStatus?.catalog?.planName || "",
      monthlyPrice: safeNumber(addonStatus?.subscription?.monthlyPrice || addonStatus?.catalog?.monthlyPrice),
      renewalDate: addonStatus?.workspace?.renewalDate || null,
    },
    balanceBreakdown: {
      includedRemainingCredits: safeNumber(addonStatus?.workspace?.remainingIncludedCredits),
      topupRemainingCredits: safeNumber(addonStatus?.workspace?.remainingTopupCredits),
      totalRemainingCredits: safeNumber(addonStatus?.workspace?.remainingCredits),
      creditsUsedThisMonth: safeNumber(usage.creditsUsed),
      creditsPurchasedThisMonth: monthlyPurchased,
      creditsRefundedThisMonth: monthlyRefunded,
      creditsAdjustedThisMonth: monthlyAdjusted,
      creditsExpiredThisMonth: monthlyExpired,
    },
    usage: {
      totalRequests: safeNumber(usage.totalRequests),
      totalConversations: Array.isArray(usage.conversations) ? usage.conversations.filter(Boolean).length : 0,
      avgCreditsPerRequest,
      avgCreditsPerConversation:
        Array.isArray(usage.conversations) && usage.conversations.filter(Boolean).length
          ? Number((safeNumber(usage.creditsUsed) / usage.conversations.filter(Boolean).length).toFixed(3))
          : 0,
      estimatedRemainingRuntime,
    },
    spendingTrend: trendRows.map((row) => ({
      date: row._id,
      creditsUsed: safeNumber(row.creditsUsed),
      requests: safeNumber(row.requests),
    })),
    budget: budgetStatus,
    billing: addonStatus,
  };
}

async function getUsageAnalytics({ workspaceId, query = {} }) {
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);
  const agentObjectId = toObjectId(query.agentId);
  const channel = query.channel ? String(query.channel) : "";
  const match = {
    workspaceId,
    createdAt: { $gte: dateFrom, $lte: dateTo },
  };
  if (agentObjectId) match.agentId = agentObjectId;
  if (channel && ["test", "whatsapp", "api"].includes(channel)) match["metadata.channel"] = channel;

  const [workspaceRows, agentRows, modelRows, agentDocs] = await Promise.all([
    AiUsageLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          creditsConsumed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
          conversations: { $addToSet: "$conversationId" },
        },
      },
    ]),
    AiUsageLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$agentId",
          creditsConsumed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
          conversations: { $addToSet: "$conversationId" },
          avgConfidence: { $avg: "$metadata.confidence" },
          avgRuntimeCost: { $avg: "$estimatedCost" },
        },
      },
      { $sort: { creditsConsumed: -1, requests: -1 } },
    ]),
    AiUsageLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$model",
          creditsConsumed: { $sum: "$creditsUsed" },
          tokenConsumption: { $sum: "$totalTokens" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { creditsConsumed: -1, tokenConsumption: -1 } },
    ]),
    AiAgent.find({ workspaceId, deletedAt: null }).select("_id name").lean(),
  ]);
  const agentMap = new Map(agentDocs.map((item) => [String(item._id), item.name]));
  const workspace = workspaceRows[0] || {};
  const conversationCount = Array.isArray(workspace.conversations) ? workspace.conversations.filter(Boolean).length : 0;

  return {
    success: true,
    filters: {
      preset,
      dateFrom,
      dateTo,
      agentId: agentObjectId ? String(agentObjectId) : "",
      channel,
    },
    workspace: {
      creditsConsumed: safeNumber(workspace.creditsConsumed),
      requests: safeNumber(workspace.requests),
      conversations: conversationCount,
      avgCreditsPerConversation: conversationCount ? Number((safeNumber(workspace.creditsConsumed) / conversationCount).toFixed(3)) : 0,
      avgCreditsPerRequest: safeNumber(workspace.requests) ? Number((safeNumber(workspace.creditsConsumed) / safeNumber(workspace.requests)).toFixed(3)) : 0,
    },
    agents: agentRows.map((row) => {
      const conversations = Array.isArray(row.conversations) ? row.conversations.filter(Boolean).length : 0;
      return {
        agentId: row._id ? String(row._id) : "",
        agentName: agentMap.get(String(row._id)) || "Unknown Agent",
        creditsConsumed: safeNumber(row.creditsConsumed),
        requests: safeNumber(row.requests),
        conversations,
        avgConfidence: Number(safeNumber(row.avgConfidence).toFixed(3)),
        avgRuntimeCost: Number(safeNumber(row.avgRuntimeCost).toFixed(3)),
      };
    }),
    models: modelRows.map((row) => ({
      model: String(row._id || "unknown"),
      creditsConsumed: safeNumber(row.creditsConsumed),
      tokenConsumption: safeNumber(row.tokenConsumption),
      requests: safeNumber(row.requests),
    })),
  };
}

async function getBillingTimeline({ workspaceId, query = {} }) {
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);
  const rows = await AiCreditTransaction.find({
    workspaceId,
    createdAt: { $gte: dateFrom, $lte: dateTo },
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(normalizeLimit(query.limit, 100, 200))
    .lean();
  return {
    success: true,
    filters: { preset, dateFrom, dateTo },
    items: rows.map((row) => ({
      id: String(row._id),
      transactionId: String(row._id),
      eventType: mapLedgerEntryType(row),
      eventLabel: timelineLabel(mapLedgerEntryType(row), row.source),
      description: row.description || "",
      credits: safeNumber(row.credits),
      amount: safeNumber(row.amount),
      currency: row.currency || "INR",
      direction: row.direction || "credit",
      source: row.source || "",
      reason: row.reason || "",
      createdAt: row.createdAt || null,
    })),
  };
}

async function getUsageExplorer({ workspaceId, query = {} }) {
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);
  const page = Math.max(1, safeNumber(query.page, 1));
  const limit = normalizeLimit(query.limit, 25, 100);
  const skip = (page - 1) * limit;
  const match = {
    workspaceId,
    createdAt: { $gte: dateFrom, $lte: dateTo },
  };
  if (query.agentId && mongoose.Types.ObjectId.isValid(String(query.agentId))) {
    match.agentId = toObjectId(query.agentId);
  }
  if (query.model) match.model = String(query.model);
  if (query.runtimeStatus) match.status = String(query.runtimeStatus);
  if (query.executionId) match.executionKey = new RegExp(escapeRegex(query.executionId), "i");
  if (query.conversationId && mongoose.Types.ObjectId.isValid(String(query.conversationId))) {
    match.conversationId = toObjectId(query.conversationId);
  }
  if (query.creditMin || query.creditMax) {
    match.creditsUsed = {};
    if (query.creditMin !== undefined && query.creditMin !== "") match.creditsUsed.$gte = safeNumber(query.creditMin);
    if (query.creditMax !== undefined && query.creditMax !== "") match.creditsUsed.$lte = safeNumber(query.creditMax);
  }
  if (query.search) {
    const regex = new RegExp(escapeRegex(query.search), "i");
    match.$or = [{ executionKey: regex }, { model: regex }];
  }
  if (query.channel && ["test", "whatsapp", "api"].includes(String(query.channel))) {
    match["metadata.channel"] = String(query.channel);
  }
  if (query.conversationStatus) {
    const conversationIds = await AiConversation.find({ workspaceId, aiState: query.conversationStatus }).select("_id").lean();
    match.conversationId = { $in: conversationIds.map((item) => item._id) };
  }

  const [total, rows, agents] = await Promise.all([
    AiUsageLog.countDocuments(match),
    AiUsageLog.find(match).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    AiAgent.find({ workspaceId, deletedAt: null }).select("_id name").lean(),
  ]);
  const agentMap = new Map(agents.map((item) => [String(item._id), item.name]));
  const conversationIds = Array.from(new Set(rows.map((item) => String(item.conversationId || "")).filter(Boolean)));
  const conversations = conversationIds.length
    ? await AiConversation.find({ _id: { $in: conversationIds }, workspaceId }).select("_id contactId aiState status").lean()
    : [];
  const contacts = conversations.length
    ? await Contact.find({
        _id: {
          $in: conversations.map((item) => item.contactId).filter(Boolean),
        },
        workspaceId,
      }).select("_id name phone").lean()
    : [];
  const conversationMap = new Map(conversations.map((item) => [String(item._id), item]));
  const contactMap = new Map(contacts.map((item) => [String(item._id), item]));

  return {
    success: true,
    filters: { preset, dateFrom, dateTo },
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    items: rows.map((row) => {
      const conversation = row.conversationId ? conversationMap.get(String(row.conversationId)) : null;
      const contact = conversation?.contactId ? contactMap.get(String(conversation.contactId)) : null;
      return {
        id: String(row._id),
        executionId: row.executionKey || "",
        agentId: row.agentId ? String(row.agentId) : "",
        agentName: agentMap.get(String(row.agentId || "")) || "Unknown Agent",
        conversationId: row.conversationId ? String(row.conversationId) : "",
        conversationStatus: conversation?.aiState || conversation?.status || "",
        contactId: conversation?.contactId ? String(conversation.contactId) : "",
        contactName: contact?.name || "",
        contactPhone: contact?.phone || "",
        runtimeStatus: row.status || "",
        action: row.action || "",
        model: row.model || "",
        provider: row.provider || "",
        creditsUsed: safeNumber(row.creditsUsed),
        inputTokens: safeNumber(row.inputTokens),
        outputTokens: safeNumber(row.outputTokens),
        totalTokens: safeNumber(row.totalTokens),
        estimatedCost: safeNumber(row.estimatedCost),
        latencyMs: safeNumber(row.latencyMs),
        confidence: Number(safeNumber(row.metadata?.confidence).toFixed(3)),
        createdAt: row.createdAt || null,
      };
    }),
  };
}

async function getWorkspaceReport({ workspaceId, query = {} }) {
  const reportType = String(query.reportType || "daily_ai_usage");
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);

  if (reportType === "daily_ai_usage") {
    const rows = await AiUsageLog.aggregate([
      { $match: { workspaceId, createdAt: { $gte: dateFrom, $lte: dateTo } } },
      {
        $project: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          creditsUsed: 1,
          conversationId: 1,
        },
      },
      {
        $group: {
          _id: "$day",
          creditsUsed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
          conversations: { $addToSet: "$conversationId" },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const items = rows.map((row) => ({
      date: row._id,
      creditsUsed: safeNumber(row.creditsUsed),
      requests: safeNumber(row.requests),
      conversations: Array.isArray(row.conversations) ? row.conversations.filter(Boolean).length : 0,
    }));
    return { success: true, reportType, filters: { preset, dateFrom, dateTo }, items };
  }

  if (reportType === "monthly_ai_billing") {
    return listBillingStatements({ workspaceId, query: { period: query.period || monthKey(new Date()), limit: 1 } });
  }

  if (reportType === "top_consuming_agents") {
    const analytics = await getUsageAnalytics({ workspaceId, query });
    return { success: true, reportType, filters: analytics.filters, items: analytics.agents };
  }

  if (reportType === "refund_summary" || reportType === "adjustment_summary" || reportType === "revenue_summary") {
    const entryTypes =
      reportType === "refund_summary"
        ? ["refund"]
        : reportType === "adjustment_summary"
          ? ["manual_adjustment", "migration_adjustment"]
          : ["included_credit_allocation", "topup_purchase", "subscription_reset"];
    const rows = await AiCreditTransaction.find({
      workspaceId,
      createdAt: { $gte: dateFrom, $lte: dateTo },
    }).lean();
    const items = rows
      .filter((row) => entryTypes.includes(mapLedgerEntryType(row)))
      .map((row) => ({
        transactionId: String(row._id),
        entryType: mapLedgerEntryType(row),
        credits: safeNumber(row.credits),
        amount: safeNumber(row.amount),
        currency: row.currency || "INR",
        description: row.description || "",
        source: row.source || "",
        createdAt: row.createdAt || null,
      }));
    return { success: true, reportType, filters: { preset, dateFrom, dateTo }, items };
  }

  throw new HttpError(400, "Unsupported AI report type.");
}

async function downloadWorkspaceReportCsv({ workspaceId, query = {} }) {
  const report = await getWorkspaceReport({ workspaceId, query });
  const items = Array.isArray(report.items) ? report.items : Array.isArray(report.transactions) ? report.transactions : [];
  const first = items[0] || {};
  const columns = Object.keys(first).map((key) => ({ label: key, value: key }));
  return {
    filename: `ai-report-${String(query.reportType || "report")}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(items, columns.length ? columns : [{ label: "value", value: () => "" }]),
  };
}

async function getAdminFinancialDashboard({ query = {} }) {
  const { dateFrom, dateTo, preset } = normalizeDateRange(query);
  const usageMatch = {
    createdAt: { $gte: dateFrom, $lte: dateTo },
  };
  if (query.workspaceId && mongoose.Types.ObjectId.isValid(String(query.workspaceId))) {
    usageMatch.workspaceId = toObjectId(query.workspaceId);
  }
  if (query.agentId && mongoose.Types.ObjectId.isValid(String(query.agentId))) {
    usageMatch.agentId = toObjectId(query.agentId);
  }
  if (query.channel && ["test", "whatsapp", "api"].includes(String(query.channel))) {
    usageMatch["metadata.channel"] = String(query.channel);
  }

  const ledgerMatch = {
    createdAt: { $gte: dateFrom, $lte: dateTo },
  };
  if (usageMatch.workspaceId) ledgerMatch.workspaceId = usageMatch.workspaceId;

  const [usageRows, ledgerRows, activeSubscriptions, workspaceUsageRows, agentUsageRows, workspaces, agents] = await Promise.all([
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: null,
          creditsConsumed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
          runtimeErrors: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          handovers: { $sum: { $cond: [{ $eq: ["$action", "handover"] }, 1, 0] } },
        },
      },
    ]),
    AiCreditTransaction.find(ledgerMatch).lean(),
    AiSubscription.countDocuments({ status: "active" }),
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: "$workspaceId",
          creditsConsumed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { creditsConsumed: -1 } },
      { $limit: 5 },
    ]),
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: "$agentId",
          creditsConsumed: { $sum: "$creditsUsed" },
          requests: { $sum: 1 },
        },
      },
      { $sort: { creditsConsumed: -1 } },
      { $limit: 5 },
    ]),
    Workspace.find({}).select("_id name businessName slug").lean(),
    AiAgent.find({ deletedAt: null }).select("_id name workspaceId").lean(),
  ]);
  const usage = usageRows[0] || {};
  const workspaceMap = new Map(workspaces.map((row) => [String(row._id), row]));
  const agentMap = new Map(agents.map((row) => [String(row._id), row]));

  const aiRevenue = ledgerRows
    .filter((row) => ["included_credit_allocation", "subscription_reset"].includes(mapLedgerEntryType(row)))
    .reduce((sum, row) => sum + safeNumber(row.amount), 0);
  const topupRevenue = ledgerRows
    .filter((row) => mapLedgerEntryType(row) === "topup_purchase")
    .reduce((sum, row) => sum + safeNumber(row.amount), 0);
  const refundsIssued = ledgerRows
    .filter((row) => mapLedgerEntryType(row) === "refund")
    .reduce((sum, row) => sum + safeNumber(row.credits), 0);
  const manualAdjustments = ledgerRows
    .filter((row) => ["manual_adjustment", "migration_adjustment"].includes(mapLedgerEntryType(row)))
    .reduce((sum, row) => sum + signedCredits(row), 0);
  const creditsSold = ledgerRows
    .filter((row) => ["included_credit_allocation", "subscription_reset", "topup_purchase"].includes(mapLedgerEntryType(row)))
    .reduce((sum, row) => sum + safeNumber(row.credits), 0);

  return {
    success: true,
    filters: { preset, dateFrom, dateTo },
    metrics: {
      aiRevenue,
      topupRevenue,
      activeSubscriptions,
      creditsSold,
      creditsConsumed: safeNumber(usage.creditsConsumed),
      refundsIssued,
      manualAdjustments,
      runtimeErrors: safeNumber(usage.runtimeErrors),
      failedCalls: safeNumber(usage.runtimeErrors),
      handoverRate: safeNumber(usage.requests) ? Number(((safeNumber(usage.handovers) / safeNumber(usage.requests)) * 100).toFixed(1)) : 0,
    },
    highestConsumingWorkspaces: workspaceUsageRows.map((row) => ({
      workspaceId: row._id ? String(row._id) : "",
      workspaceName: workspaceMap.get(String(row._id))?.name || workspaceMap.get(String(row._id))?.businessName || workspaceMap.get(String(row._id))?.slug || "Unknown Workspace",
      creditsConsumed: safeNumber(row.creditsConsumed),
      requests: safeNumber(row.requests),
    })),
    highestConsumingAgents: agentUsageRows.map((row) => ({
      agentId: row._id ? String(row._id) : "",
      agentName: agentMap.get(String(row._id))?.name || "Unknown Agent",
      workspaceId: agentMap.get(String(row._id))?.workspaceId ? String(agentMap.get(String(row._id)).workspaceId) : "",
      creditsConsumed: safeNumber(row.creditsConsumed),
      requests: safeNumber(row.requests),
    })),
  };
}

async function listAdminLedgerHistory({ query = {} }) {
  const rows = await AiCreditTransaction.find({
    ...(query.workspaceId && mongoose.Types.ObjectId.isValid(String(query.workspaceId))
      ? { workspaceId: toObjectId(query.workspaceId) }
      : {}),
    ...(query.dateFrom || query.dateTo
      ? {
          createdAt: {
            ...(query.dateFrom ? { $gte: startOfDay(new Date(query.dateFrom)) } : {}),
            ...(query.dateTo ? { $lte: endOfDay(new Date(query.dateTo)) } : {}),
          },
        }
      : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(normalizeLimit(query.limit, 100, 250))
    .lean();
  const workspaceIds = Array.from(new Set(rows.map((row) => String(row.workspaceId)).filter(Boolean)));
  const workspaces = workspaceIds.length
    ? await Workspace.find({ _id: { $in: workspaceIds } }).select("_id name businessName slug").lean()
    : [];
  const workspaceMap = new Map(workspaces.map((row) => [String(row._id), row]));
  return {
    success: true,
    items: rows.map((row) => ({
      ...aiAddonService.serializeTransaction(row),
      workspace: workspaceMap.get(String(row.workspaceId)) || null,
    })),
  };
}

async function applyAdminFinancialAction({ workspaceId, actorId, type, credits, reason, reference, actorName }) {
  const actorUser = actorId ? await User.findById(actorId).select("name email").lean() : null;
  return aiAddonService.applyAdjustment({
    workspaceId,
    userId: null,
    type,
    credits,
    reason,
    reference,
    source: type === "refund" ? "admin_refund" : "admin_adjustment",
    entryType: type === "refund" ? "refund" : "manual_adjustment",
    actor: {
      actorType: "super_admin",
      actorId: actorId || null,
      actorName: String(actorName || actorUser?.name || actorUser?.email || "Super Admin"),
    },
  });
}

async function getAdminReport({ query = {} }) {
  const reportType = String(query.reportType || "revenue_summary");
  if (reportType === "top_consuming_workspaces" || reportType === "top_consuming_agents") {
    const dashboard = await getAdminFinancialDashboard({ query });
    return {
      success: true,
      reportType,
      filters: dashboard.filters,
      items: reportType === "top_consuming_workspaces" ? dashboard.highestConsumingWorkspaces : dashboard.highestConsumingAgents,
    };
  }
  if (reportType === "refund_summary" || reportType === "adjustment_summary" || reportType === "revenue_summary") {
    const ledger = await listAdminLedgerHistory({ query });
    const entryTypes =
      reportType === "refund_summary"
        ? ["refund"]
        : reportType === "adjustment_summary"
          ? ["manual_adjustment", "migration_adjustment"]
          : ["included_credit_allocation", "subscription_reset", "topup_purchase"];
    return {
      success: true,
      reportType,
      items: (ledger.items || []).filter((item) => entryTypes.includes(item.entryType)),
    };
  }
  throw new HttpError(400, "Unsupported admin AI report type.");
}

async function downloadAdminReportCsv({ query = {} }) {
  const report = await getAdminReport({ query });
  const items = Array.isArray(report.items) ? report.items : [];
  const first = items[0] || {};
  const columns = Object.keys(first).map((key) => ({ label: key, value: key }));
  return {
    filename: `ai-admin-report-${String(query.reportType || "report")}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: buildCsv(items, columns.length ? columns : [{ label: "value", value: () => "" }]),
  };
}

module.exports = {
  applyAdminFinancialAction,
  buildBudgetStatus,
  downloadAdminReportCsv,
  downloadBillingStatementCsv,
  downloadWorkspaceReportCsv,
  getAdminFinancialDashboard,
  getAdminReport,
  getBillingStatement,
  getBillingSummary,
  getBillingTimeline,
  getUsageAnalytics,
  getUsageExplorer,
  getWorkspaceReport,
  listAdminLedgerHistory,
  listBillingStatements,
  upsertBudgetConfig,
};
