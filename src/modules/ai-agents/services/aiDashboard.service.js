const mongoose = require("mongoose");
const { AiAgent } = require("@infra/database/AiAgent");
const { AiConversation } = require("@infra/database/AiConversation");
const { AiUsageLog } = require("@infra/database/AiUsageLog");
const { KnowledgeSource } = require("@infra/database/KnowledgeSource");
const { Contact } = require("@infra/database/Contact");
const { Conversation } = require("@infra/database/Conversation");
const { Message } = require("@infra/database/Message");
const { FlowSession } = require("@infra/database/FlowSession");
const { Workspace } = require("@infra/database/Workspace");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");
const aiProviderConfigService = require("@modules/ai-agents/services/aiProviderConfig.service");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");

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

function toObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return null;
  return new mongoose.Types.ObjectId(value);
}

function normalizeChannel(value) {
  return ["test", "whatsapp", "api"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "";
}

function buildUsageMatch({ workspaceId, dateFrom, dateTo, agentObjectId, channel }) {
  const match = { workspaceId };
  if (dateFrom || dateTo) {
    match.createdAt = {};
    if (dateFrom) match.createdAt.$gte = dateFrom;
    if (dateTo) match.createdAt.$lte = dateTo;
  }
  if (agentObjectId) match.agentId = agentObjectId;
  if (channel) match["metadata.channel"] = channel;
  return match;
}

function buildConversationMatch({ workspaceId, agentObjectId, channel }) {
  const match = { workspaceId, deletedAt: null };
  if (agentObjectId) match.agentId = agentObjectId;
  if (channel) match.channel = channel;
  return match;
}

function safePercent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function mapUsageSeries(rows, sinceDate, days) {
  const dailyUsageMap = new Map(rows.map((item) => [item._id, item]));
  return Array.from({ length: days }).map((_, index) => {
    const day = new Date(sinceDate.getTime() + index * 24 * 60 * 60 * 1000);
    const key = day.toISOString().slice(0, 10);
    const row = dailyUsageMap.get(key);
    return {
      date: key,
      creditsUsed: Number(row?.creditsUsed || 0),
      totalTokens: Number(row?.totalTokens || 0),
      requests: Number(row?.requests || 0),
      failures: Number(row?.failures || 0),
      replies: Number(row?.replies || 0),
      handovers: Number(row?.handovers || 0),
    };
  });
}

async function getDashboard({ workspaceId, query = {} }) {
  const geminiConfig = await aiProviderConfigService.getGeminiProviderConfig();
  const now = new Date();
  const today = startOfDay(now);
  const monthStart = startOfMonth(now);
  const rangeStart = query.dateFrom ? startOfDay(new Date(query.dateFrom)) : monthStart;
  const rangeEnd = query.dateTo ? endOfDay(new Date(query.dateTo)) : endOfDay(now);
  const agentObjectId = toObjectId(query.agentId);
  const channel = normalizeChannel(query.channel);
  const usageMatch = buildUsageMatch({
    workspaceId,
    dateFrom: rangeStart,
    dateTo: rangeEnd,
    agentObjectId,
    channel,
  });
  const conversationMatch = buildConversationMatch({ workspaceId, agentObjectId, channel });
  const since7d = new Date(startOfDay(rangeEnd).getTime() - 6 * 24 * 60 * 60 * 1000);

  const [addonStatus, workspace, activeConnection, agents, conversations, inboxConversations, usageSummaryRows, knowledgeCounts, usageSeriesRaw, topAgentUsage, channelBreakdownRaw] = await Promise.all([
    aiAddonService.getAddonStatus({ workspaceId }),
    Workspace.findById(workspaceId).select("_id isActive status aiAgentEnabled timezone").lean(),
    resolveActiveConnection(workspaceId).catch(() => null),
    AiAgent.find({ workspaceId, deletedAt: null })
      .select("_id name status persona modelName runtimeControls stats createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean(),
    AiConversation.find(conversationMatch)
      .select("_id agentId contactId channel status lastMessageAt messages metadata")
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(20)
      .lean(),
    Conversation.find({ workspaceId, deletedAt: null })
      .select("phone aiState aiHandoverAt aiHandoverReason aiLastReplyAt aiLastErrorAt aiLastErrorMessage aiAgentId assignedEmployeeId automationPausedAt automationPauseReason automationPausedByFlowSessionId lastMessageAt lastMessagePreview lastInboundAt")
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(8)
      .lean(),
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: null,
          totalTokens: { $sum: "$totalTokens" },
          totalCredits: { $sum: "$creditsUsed" },
          totalRequests: { $sum: 1 },
          repliesCount: {
            $sum: {
              $cond: [{ $eq: ["$action", "reply"] }, 1, 0],
            },
          },
          handoverCount: {
            $sum: {
              $cond: [{ $eq: ["$action", "handover"] }, 1, 0],
            },
          },
          blockedCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "blocked"] }, 1, 0],
            },
          },
          successCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "success"] }, 1, 0],
            },
          },
          failureCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "failed"] }, 1, 0],
            },
          },
          avgLatencyMs: { $avg: "$latencyMs" },
          estimatedCost: { $sum: "$estimatedCost" },
          knowledgeHitCount: {
            $sum: {
              $cond: [
                {
                  $gt: [
                    {
                      $size: {
                        $ifNull: ["$metadata.knowledgeChunks", []],
                      },
                    },
                    0,
                  ],
                },
                1,
                0,
              ],
            },
          },
          whatsappReplies: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$action", "reply"] },
                    { $eq: ["$metadata.channel", "whatsapp"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          testReplies: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$action", "reply"] },
                    { $eq: ["$metadata.channel", "test"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          apiReplies: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$action", "reply"] },
                    { $eq: ["$metadata.channel", "api"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    KnowledgeSource.aggregate([
      { $match: { workspaceId, deletedAt: null } },
      {
        $group: {
          _id: null,
          totalSources: { $sum: 1 },
          indexedSources: {
            $sum: { $cond: [{ $eq: ["$status", "indexed"] }, 1, 0] },
          },
        },
      },
    ]),
    AiUsageLog.aggregate([
      {
        $match: buildUsageMatch({
          workspaceId,
          dateFrom: since7d,
          dateTo: rangeEnd,
          agentObjectId,
          channel,
        }),
      },
      {
        $project: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          creditsUsed: 1,
          totalTokens: 1,
          status: 1,
          action: 1,
        },
      },
      {
        $group: {
          _id: "$day",
          creditsUsed: { $sum: "$creditsUsed" },
          totalTokens: { $sum: "$totalTokens" },
          requests: { $sum: 1 },
          failures: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          replies: { $sum: { $cond: [{ $eq: ["$action", "reply"] }, 1, 0] } },
          handovers: { $sum: { $cond: [{ $eq: ["$action", "handover"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: "$agentId",
          creditsUsed: { $sum: "$creditsUsed" },
          totalTokens: { $sum: "$totalTokens" },
          requests: { $sum: 1 },
          replies: { $sum: { $cond: [{ $eq: ["$action", "reply"] }, 1, 0] } },
          handovers: { $sum: { $cond: [{ $eq: ["$action", "handover"] }, 1, 0] } },
          failures: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
          lastUsedAt: { $max: "$createdAt" },
        },
      },
      { $sort: { requests: -1, replies: -1, lastUsedAt: -1 } },
      { $limit: 5 },
    ]),
    AiUsageLog.aggregate([
      { $match: usageMatch },
      {
        $group: {
          _id: { $ifNull: ["$metadata.channel", "unknown"] },
          requests: { $sum: 1 },
          creditsUsed: { $sum: "$creditsUsed" },
          replies: { $sum: { $cond: [{ $eq: ["$action", "reply"] }, 1, 0] } },
          handovers: { $sum: { $cond: [{ $eq: ["$action", "handover"] }, 1, 0] } },
        },
      },
      { $sort: { requests: -1, _id: 1 } },
    ]),
  ]);

  const contactIds = Array.from(new Set(conversations.map((item) => String(item.contactId || "")).filter(Boolean)));
  const inboxPhones = Array.from(new Set(inboxConversations.map((item) => String(item.phone || "")).filter(Boolean)));
  const contacts = contactIds.length || inboxPhones.length
    ? await Contact.find({
      workspaceId,
      $or: [
        ...(contactIds.length ? [{ _id: { $in: contactIds } }] : []),
        ...(inboxPhones.length ? [{ phone: { $in: inboxPhones } }] : []),
      ],
    }).select("_id name phone").lean()
    : [];
  const contactMap = new Map(contacts.map((item) => [String(item._id), item]));
  const contactByPhone = new Map(contacts.map((item) => [String(item.phone || ""), item]));
  const agentMap = new Map(agents.map((item) => [String(item._id), item]));
  const inboxContactIds = Array.from(
    new Set(
      inboxConversations
        .map((item) => contactByPhone.get(String(item.phone || ""))?._id)
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  );
  const activeFlowSessions = inboxContactIds.length
    ? await FlowSession.find({
      workspaceId,
      contactId: { $in: inboxContactIds },
      status: "active",
    }).select("_id contactId flowId status expiresAt waitingFor updatedAt").lean()
    : [];
  const activeFlowByContactId = new Map(activeFlowSessions.map((item) => [String(item.contactId || ""), item]));
  const recentInboundRuntimeMessages = inboxPhones.length
    ? await Message.find({
      workspaceId,
      direction: "inbound",
      phone: { $in: inboxPhones },
    })
      .select("phone aiStatus aiReason aiError aiProcessedAt receivedAt createdAt")
      .sort({ receivedAt: -1, createdAt: -1 })
      .lean()
    : [];
  const latestInboundByPhone = new Map();
  for (const item of recentInboundRuntimeMessages) {
    const phone = String(item.phone || "").trim();
    if (!phone || latestInboundByPhone.has(phone)) continue;
    latestInboundByPhone.set(phone, item);
  }

  const agentCounts = agents.reduce(
    (acc, agent) => {
      acc.total += 1;
      acc[String(agent.status || "draft")] = Number(acc[String(agent.status || "draft")] || 0) + 1;
      return acc;
    },
    { total: 0, active: 0, draft: 0, paused: 0, archived: 0 }
  );

  const conversationCounts = conversations.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[String(item.status || "active")] = Number(acc[String(item.status || "active")] || 0) + 1;
      return acc;
    },
    { total: 0, active: 0, handover: 0, closed: 0 }
  );

  const usageSummary = usageSummaryRows[0] || {};
  const knowledgeSummary = knowledgeCounts[0] || {};

  const todayUsageMatch = buildUsageMatch({
    workspaceId,
    dateFrom: today,
    dateTo: endOfDay(now),
    agentObjectId,
    channel,
  });
  const monthUsageMatch = buildUsageMatch({
    workspaceId,
    dateFrom: monthStart,
    dateTo: endOfDay(now),
    agentObjectId,
    channel,
  });
  const [todayUsageRows, monthUsageRows] = await Promise.all([
    AiUsageLog.aggregate([
      { $match: todayUsageMatch },
      {
        $group: {
          _id: null,
          creditsUsed: { $sum: "$creditsUsed" },
          replies: { $sum: { $cond: [{ $eq: ["$action", "reply"] }, 1, 0] } },
        },
      },
    ]),
    AiUsageLog.aggregate([
      { $match: monthUsageMatch },
      {
        $group: {
          _id: null,
          creditsUsed: { $sum: "$creditsUsed" },
          replies: { $sum: { $cond: [{ $eq: ["$action", "reply"] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const todayUsage = todayUsageRows[0] || {};
  const monthUsage = monthUsageRows[0] || {};
  const totalRequests = Number(usageSummary.totalRequests || 0);
  const repliesCount = Number(usageSummary.repliesCount || 0);
  const handoverCount = Number(usageSummary.handoverCount || 0);
  const blockedCount = Number(usageSummary.blockedCount || 0);
  const successCount = Number(usageSummary.successCount || 0);
  const failureCount = Number(usageSummary.failureCount || 0);
  const knowledgeHitCount = Number(usageSummary.knowledgeHitCount || 0);

  const usageSeries = mapUsageSeries(usageSeriesRaw, since7d, 7);

  const topAgents = topAgentUsage.map((item) => {
    const agent = agentMap.get(String(item._id));
    return {
      id: String(item._id),
      name: agent?.name || "Unknown Agent",
      status: agent?.status || "draft",
      persona: agent?.persona || "custom",
      conversations: Number(agent?.stats?.conversations || 0),
      messages: Number(item.requests || 0),
      handovers: Number(item.handovers || 0),
      lastUsedAt: item.lastUsedAt || agent?.stats?.lastUsedAt || null,
      creditsUsed: Number(item.creditsUsed || 0),
      totalTokens: Number(item.totalTokens || 0),
      replies: Number(item.replies || 0),
      failures: Number(item.failures || 0),
    };
  });

  const recentConversations = conversations.map((item) => {
    const agent = agentMap.get(String(item.agentId || ""));
    const contact = contactMap.get(String(item.contactId || ""));
    const messages = Array.isArray(item.messages) ? item.messages : [];
    const preview = messages.length ? String(messages[messages.length - 1]?.text || "").slice(0, 180) : "";
    return {
      id: String(item._id),
      agentId: String(item.agentId || ""),
      agentName: agent?.name || "Unknown Agent",
      contactId: item.contactId ? String(item.contactId) : null,
      contactName: contact?.name || "",
      contactPhone: contact?.phone || "",
      channel: item.channel || "test",
      status: item.status || "active",
      lastMessageAt: item.lastMessageAt || null,
      messageCount: messages.length,
      preview,
    };
  });

  const activeAgents = agents.filter((agent) => String(agent.status || "").toLowerCase() === "active");
  const whatsappCapableAgents = activeAgents.filter((agent) => {
    const channels = Array.isArray(agent?.runtimeControls?.routing?.channels) ? agent.runtimeControls.routing.channels : [];
    return !channels.length || channels.includes("whatsapp");
  });
  const liveBlockers = [];
  if (!workspace?.isActive || String(workspace?.status || "").toLowerCase() !== "active") {
    liveBlockers.push({
      code: "workspace_inactive",
      severity: "error",
      title: "Workspace inactive",
      message: "This workspace must be active before live WhatsApp AI can reply.",
      action: "Fix workspace status first.",
    });
  }
  if (!workspace?.aiAgentEnabled) {
    liveBlockers.push({
      code: "ai_disabled",
      severity: "error",
      title: "AI add-on disabled",
      message: "Live AI runtime is turned off for this workspace.",
      action: "Enable the AI add-on for this workspace.",
    });
  }
  if (!activeConnection?.wabaId || !activeConnection?.phoneNumberId) {
    liveBlockers.push({
      code: "whatsapp_not_connected",
      severity: "error",
      title: "WhatsApp not connected",
      message: "An active WhatsApp connection is required for live replies.",
      action: "Reconnect WhatsApp for this workspace.",
    });
  }
  if (!activeAgents.length) {
    liveBlockers.push({
      code: "no_active_agent",
      severity: "warn",
      title: "No active AI agent",
      message: "Test chat can work for drafts, but live WhatsApp runtime needs an active agent.",
      action: "Change at least one agent status to active.",
    });
  }
  if (activeAgents.length && !whatsappCapableAgents.length) {
    liveBlockers.push({
      code: "no_whatsapp_agent",
      severity: "warn",
      title: "No agent routed to WhatsApp",
      message: "Active agents exist, but none are configured to handle the WhatsApp channel.",
      action: "Add `whatsapp` to the routing channels of an active agent.",
    });
  }

  const liveConversations = inboxConversations.map((item) => {
    const phone = String(item.phone || "").trim();
    const contact = contactByPhone.get(phone);
    const flowSession = contact?._id ? activeFlowByContactId.get(String(contact._id)) : null;
    const latestInbound = latestInboundByPhone.get(phone);
    const aiState = String(item.aiState || "").trim() || null;
    const blockedReasons = [];
    if (item.assignedEmployeeId) blockedReasons.push("human_takeover");
    if (item.automationPausedAt) blockedReasons.push("automation_paused");
    if (flowSession?._id) blockedReasons.push("active_flow_session");
    if (item.aiLastErrorMessage) blockedReasons.push("last_runtime_error");
    if (latestInbound?.aiStatus === "failed") blockedReasons.push("last_inbound_failed");
    if (latestInbound?.aiStatus === "skipped") blockedReasons.push("last_inbound_skipped");
    if (!item.aiAgentId) blockedReasons.push("no_agent_bound_yet");
    return {
      id: String(item._id),
      phone,
      contactName: contact?.name || "",
      aiState,
      aiAgentId: item.aiAgentId ? String(item.aiAgentId) : null,
      aiAgentName: item.aiAgentId ? agentMap.get(String(item.aiAgentId))?.name || null : null,
      assignedEmployeeId: item.assignedEmployeeId ? String(item.assignedEmployeeId) : null,
      hasHumanTakeover: Boolean(item.assignedEmployeeId) || aiState === "HUMAN_ACTIVE",
      automationPausedAt: item.automationPausedAt || null,
      automationPauseReason: item.automationPauseReason || null,
      hasActiveFlowSession: Boolean(flowSession?._id),
      activeFlowSessionId: flowSession?._id ? String(flowSession._id) : null,
      activeFlowStatus: flowSession?.status || null,
      aiHandoverAt: item.aiHandoverAt || null,
      aiHandoverReason: item.aiHandoverReason || null,
      aiLastReplyAt: item.aiLastReplyAt || null,
      aiLastErrorAt: item.aiLastErrorAt || null,
      aiLastErrorMessage: item.aiLastErrorMessage || null,
      lastAiStatus: latestInbound?.aiStatus || null,
      lastAiReason: latestInbound?.aiReason || null,
      lastAiError: latestInbound?.aiError || null,
      lastAiProcessedAt: latestInbound?.aiProcessedAt || null,
      lastInboundAt: item.lastInboundAt || null,
      lastMessageAt: item.lastMessageAt || null,
      preview: String(item.lastMessagePreview || "").slice(0, 180),
      blockedReasons,
      recommendedAction: flowSession?._id
        ? "release_flow_block"
        : (Boolean(item.assignedEmployeeId) || aiState === "HUMAN_ACTIVE")
          ? "return_to_ai"
          : blockedReasons.length
            ? "inspect"
            : "none",
    };
  });

  const resolutionRate = safePercent(repliesCount, repliesCount + handoverCount);
  const deliveryToKnowledgeRate = safePercent(knowledgeHitCount, totalRequests);
  const blockedRate = safePercent(blockedCount, totalRequests);
  const successRate = safePercent(successCount, totalRequests);
  const costEstimate = Number(usageSummary.estimatedCost || 0);
  const channelBreakdown = channelBreakdownRaw.map((item) => ({
    channel: String(item._id || "unknown"),
    requests: Number(item.requests || 0),
    creditsUsed: Number(item.creditsUsed || 0),
    replies: Number(item.replies || 0),
    handovers: Number(item.handovers || 0),
  }));

  return {
    success: true,
    filters: {
      dateFrom: rangeStart.toISOString(),
      dateTo: rangeEnd.toISOString(),
      agentId: agentObjectId ? String(agentObjectId) : "",
      channel: channel || "all",
    },
    overview: {
      agentCounts,
      conversationCounts,
      knowledge: {
        totalSources: Number(knowledgeSummary.totalSources || 0),
        indexedSources: Number(knowledgeSummary.indexedSources || 0),
        knowledgeHitRate: deliveryToKnowledgeRate,
        knowledgeHitCount,
      },
      usage: {
        todayReplies: Number(todayUsage.replies || 0),
        todayCredits: Number(todayUsage.creditsUsed || 0),
        monthReplies: Number(monthUsage.replies || 0),
        monthCredits: Number(monthUsage.creditsUsed || 0),
        monthTokens: Number(usageSummary.totalTokens || 0),
        totalRequests,
        repliesCount,
        handoverCount,
        blockedCount,
        failureCount,
        successCount,
        avgLatencyMs: Math.round(Number(usageSummary.avgLatencyMs || 0)),
        resolutionRate,
        costEstimate,
        knowledgeHitRate: deliveryToKnowledgeRate,
      },
    },
    topAgents,
    recentConversations,
    liveRuntime: {
      workspaceReady: Boolean(workspace?.isActive) && String(workspace?.status || "").toLowerCase() === "active",
      aiEnabled: Boolean(workspace?.aiAgentEnabled),
      whatsappConnected: Boolean(activeConnection?.wabaId && activeConnection?.phoneNumberId),
      liveReady: liveBlockers.length === 0,
      activeAgentCount: activeAgents.length,
      whatsappCapableAgentCount: whatsappCapableAgents.length,
      activeConnection: activeConnection
        ? {
          displayPhoneNumber: activeConnection.displayPhoneNumber || null,
          wabaName: activeConnection.wabaName || null,
          connectedAt: activeConnection.connectedAt || null,
        }
        : null,
      blockers: liveBlockers,
      conversations: liveConversations,
    },
    usageSeries,
    usageBreakdown: {
      creditsUsedToday: Number(todayUsage.creditsUsed || 0),
      creditsUsedMonth: Number(monthUsage.creditsUsed || 0),
      creditsUsedRange: Number(usageSummary.totalCredits || 0),
      repliesToday: Number(todayUsage.replies || 0),
      repliesMonth: Number(monthUsage.replies || 0),
      repliesCount,
      handoverCount,
      blockedCount,
      failureCount,
      successCount,
      totalRequests,
      totalTokens: Number(usageSummary.totalTokens || 0),
      estimatedCost: costEstimate,
      avgLatencyMs: Math.round(Number(usageSummary.avgLatencyMs || 0)),
      resolutionRate,
      knowledgeHitRate: deliveryToKnowledgeRate,
      blockedRate,
      successRate,
      replyChannels: {
        whatsapp: Number(usageSummary.whatsappReplies || 0),
        test: Number(usageSummary.testReplies || 0),
        api: Number(usageSummary.apiReplies || 0),
      },
    },
    channelBreakdown,
    billing: addonStatus,
    settings: {
      provider: "gemini",
      modelDefault: geminiConfig.defaultModel,
      availableModels: geminiConfig.models.map((item) => ({
        key: item.key,
        label: item.label,
        deprecated: Boolean(item.deprecated),
      })),
      tokensPerCredit: aiAddonService.AI_AGENT_TOKENS_PER_CREDIT,
      renewalDate: addonStatus?.workspace?.renewalDate || null,
    },
  };
}

module.exports = { getDashboard };
