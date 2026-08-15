const mongoose = require("mongoose");
const { Workspace } = require("@infra/database/Workspace");
const { Conversation } = require("@infra/database/Conversation");
const { Contact } = require("@infra/database/Contact");
const { Message } = require("@infra/database/Message");
const { FlowSession } = require("@infra/database/FlowSession");
const { AiConversation } = require("@infra/database/AiConversation");
const { AiAgent } = require("@infra/database/AiAgent");
const { AiCreditTransaction } = require("@infra/database/AiCreditTransaction");
const aiProviderService = require("@modules/ai-agents/services/aiProvider.service");
const aiPromptBuilder = require("@modules/ai-agents/services/aiPromptBuilder.service");
const aiGuardrailService = require("@modules/ai-agents/services/aiGuardrail.service");
const aiToolService = require("@modules/ai-agents/services/aiTool.service");
const aiBillingService = require("@modules/ai-agents/services/aiBilling.service");
const aiKnowledgeService = require("@modules/ai-agents/services/aiKnowledge.service");
const aiManagedFileSearchService = require("@modules/ai-agents/services/aiManagedFileSearch.service");
const aiConversationStyleService = require("@modules/ai-agents/services/aiConversationStyle.service");
const aiRuntimeRepository = require("@modules/ai-agents/repositories/aiRuntime.repository");
const aiMemoryService = require("@modules/ai-agents/services/aiMemory.service");
const {
  tokensToCreditsExact,
  getWorkspaceAiLimits,
} = require("@modules/ai-agents/services/aiAddon.service");
const {
  AI_STATES,
  normalizeAiState,
} = require("@modules/ai-agents/constants/aiRuntime.constants");
const {
  buildExecutionKey,
  buildOutboundReplyIdempotencyKey,
} = require("@modules/ai-agents/services/aiRuntimeIdempotency.service");
const {
  acquireConversationLock,
  extendConversationLock,
  releaseConversationLock,
} = require("@modules/ai-agents/services/aiConversationLock.service");
const {
  isRetryableRuntimeError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");
const { writeConversationEvent } = require("@modules/crm/services/conversationEvent.service");
const {
  sendTextMessageForUser,
  sendTypingIndicatorForUser,
} = require("@shared/services/outboundMessageService");

const LOCK_WINDOW_MS = Math.max(Number(process.env.AI_RUNTIME_LOCK_MS || 45000), 5000);
const LOCK_REFRESH_MS = Math.max(
  3000,
  Math.min(
    Number(process.env.AI_RUNTIME_LOCK_REFRESH_MS || Math.floor(LOCK_WINDOW_MS / 3)),
    Math.max(LOCK_WINDOW_MS - 1000, 3000)
  )
);
const TYPING_HEARTBEAT_MS = Math.max(Number(process.env.WHATSAPP_TYPING_HEARTBEAT_MS || 8000), 3000);

function asObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function creditsForUsage(inputTokens, outputTokens) {
  return tokensToCreditsExact(Number(inputTokens || 0) + Number(outputTokens || 0));
}

function serializeBilling(result) {
  if (!result) return null;
  return {
    enabled: Boolean(result.enabled),
    deducted: Boolean(result.deducted),
    creditsUsed: Number(result.creditsUsed || 0),
    remainingCredits: result.remainingCredits ?? null,
    remainingTokens: result.remainingTokens ?? null,
  };
}

async function resolveAgent({ workspaceId, conversation }) {
  const preferredId = conversation?.aiAgentId ? String(conversation.aiAgentId) : "";
  if (preferredId) {
    const preferred = await AiAgent.findOne({
      _id: preferredId,
      workspaceId,
      status: "active",
      deletedAt: null,
    });
    if (preferred) return preferred;
  }

  return AiAgent.findOne({
    workspaceId,
    status: "active",
    deletedAt: null,
  }).sort({ updatedAt: -1, createdAt: -1 });
}

function tokenizeRouteText(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0900-\u097f]+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function agentSupportsChannel(agent, channel) {
  const channels = Array.isArray(agent?.runtimeControls?.routing?.channels) ? agent.runtimeControls.routing.channels : [];
  return !channels.length || channels.includes(channel);
}

function scoreAgentRoute(agent, message, channel = "whatsapp") {
  if (!agentSupportsChannel(agent, channel)) return -1;
  const keywords = Array.isArray(agent?.runtimeControls?.routing?.keywords) ? agent.runtimeControls.routing.keywords : [];
  const priority = Number(agent?.runtimeControls?.routing?.priority || 100);
  if (!keywords.length) return priority > 0 ? 1 / Math.max(1, priority) : 0.01;
  const haystack = tokenizeRouteText(message);
  let matches = 0;
  for (const keyword of keywords) {
    const value = String(keyword || "").trim().toLowerCase();
    if (!value) continue;
    if (haystack.includes(value) || String(message || "").toLowerCase().includes(value)) matches += 1;
  }
  if (!matches) return -1;
  return matches * 1000 - priority;
}

async function resolveAgentForMessage({ workspaceId, conversation, message, channel = "whatsapp" }) {
  const preferred = await resolveAgent({ workspaceId, conversation });
  const agents = await AiAgent.find({
    workspaceId,
    status: "active",
    deletedAt: null,
  }).sort({ "runtimeControls.routing.priority": 1, updatedAt: -1, createdAt: -1 });
  if (!agents.length) return preferred;
  const ranked = agents
    .map((agent) => ({ agent, score: scoreAgentRoute(agent, message, channel) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.agent || preferred;
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "Asia/Calcutta",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    weekday: String(map.weekday || "").slice(0, 3).toLowerCase(),
    hour: Number(map.hour || 0),
    minute: Number(map.minute || 0),
  };
}

function timeToMinutes(value, fallback) {
  const text = String(value || fallback || "00:00").trim();
  const match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function evaluateBusinessHours({ agent, workspaceTimezone, now = new Date() }) {
  const config = agent?.runtimeControls?.businessHours || {};
  if (!config.enabled) return { enabled: false, withinHours: true, timezone: workspaceTimezone || "Asia/Calcutta" };
  const timezone = String(config.timezone || workspaceTimezone || "Asia/Calcutta").trim() || "Asia/Calcutta";
  const days = Array.isArray(config.days) && config.days.length ? config.days : ["mon", "tue", "wed", "thu", "fri", "sat"];
  const zoned = getZonedParts(now, timezone);
  const currentMinutes = zoned.hour * 60 + zoned.minute;
  const startMinutes = timeToMinutes(config.startTime, "09:00");
  const endMinutes = timeToMinutes(config.endTime, "18:00");
  const withinDay = days.includes(zoned.weekday);
  const withinTime = currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  return {
    enabled: true,
    withinHours: withinDay && withinTime,
    timezone,
    day: zoned.weekday,
    action: config.afterHoursAction || "reply_and_handover",
  };
}

function escalationKeywordMatched(agent, message) {
  const config = agent?.runtimeControls?.escalationRules || {};
  const keywords = Array.isArray(config.keywords) ? config.keywords : [];
  const lower = String(message || "").toLowerCase();
  return keywords.find((item) => item && lower.includes(String(item).toLowerCase())) || null;
}

function fallbackReplyFor(agent, key, fallback) {
  const templates = agent?.runtimeControls?.fallbackTemplates || {};
  return String(templates?.[key] || "").trim() || fallback;
}

function buildUsageMetadata({ executionKey, metadata = {} }) {
  return {
    ...metadata,
    executionKey,
  };
}

function createTypingIndicatorController({ workspaceId, inboundWhatsappMessageId }) {
  let timer = null;
  let active = false;
  let inFlight = null;

  async function pulse() {
    if (!active || !workspaceId || !inboundWhatsappMessageId) return;
    if (inFlight) return inFlight;
    inFlight = sendTypingIndicatorForUser({
      userId: workspaceId,
      messageId: inboundWhatsappMessageId,
      type: "text",
    })
      .catch((error) => {
        console.warn("[ai-runtime] typing indicator failed", {
          workspaceId: String(workspaceId),
          messageId: String(inboundWhatsappMessageId),
          error: String(error?.message || "Typing indicator failed"),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return {
    async start() {
      if (active || !workspaceId || !inboundWhatsappMessageId) return;
      active = true;
      await pulse();
      if (!active) return;
      timer = setInterval(() => {
        pulse().catch(() => {});
      }, TYPING_HEARTBEAT_MS);
      if (typeof timer?.unref === "function") timer.unref();
    },
    async stop() {
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight.catch(() => {});
      }
    },
  };
}

function skipReasonMessage(reason) {
  switch (String(reason || "").trim()) {
    case "human_or_paused":
      return "Conversation is under human control or automation is paused.";
    case "message_missing":
      return "Inbound message record was not found for AI processing.";
    case "already_processed":
      return "Inbound message was already handled by AI runtime.";
    case "execution_claim_mismatch":
      return "Inbound message was claimed by another AI runtime attempt.";
    case "empty_message":
      return "Inbound message has no supported text content for AI reply.";
    case "active_flow_session":
      return "An active flow session is currently controlling this conversation.";
    case "no_active_agent":
      return "No active WhatsApp AI agent matched this conversation.";
    case "conversation_missing":
      return "Conversation record was not found for AI runtime.";
    case "ai_disabled":
      return "Workspace AI live runtime is disabled.";
    default:
      return "AI runtime skipped this inbound message.";
  }
}

function logRuntimeSkip({ workspaceId, conversationId, messageId, executionKey, reason }) {
  console.info("[ai-runtime] inbound skipped", {
    workspaceId: workspaceId ? String(workspaceId) : null,
    conversationId: conversationId ? String(conversationId) : null,
    messageId: messageId ? String(messageId) : null,
    executionKey: executionKey ? String(executionKey) : null,
    reason,
    detail: skipReasonMessage(reason),
  });
}

async function markInboundMessageSkipped({
  workspaceId,
  messageId,
  executionKey,
  reason,
}) {
  if (!workspaceId || !messageId) return;
  await Message.updateOne(
    { _id: messageId, workspaceId, direction: "inbound" },
    {
      $set: {
        aiProcessedAt: new Date(),
        aiStatus: "skipped",
        aiAction: "blocked",
        aiReason: String(reason || "skipped").slice(0, 200),
        aiError: null,
        aiExecutionKey: executionKey || null,
      },
    }
  ).catch(() => {});
}

function fallbackReasonForError(error) {
  const code = String(error?.code || "").trim();
  if (code === "AI_PROVIDER_TIMEOUT") return "provider_timeout";
  if (code === "AI_PROVIDER_CIRCUIT_OPEN") return "provider_unavailable";
  if (code === "AI_TOOL_TIMEOUT") return "tool_timeout";
  if (code === "AI_PROVIDER_RETRYABLE") return "provider_unavailable";
  if (code === "AI_CONVERSATION_LOCK_BUSY" || code === "AI_CONVERSATION_LOCK_LOST") return "lock_contention";
  return "runtime_unavailable";
}

function fallbackReplyForRuntimeError(agent, error) {
  const reason = fallbackReasonForError(error);
  if (reason === "provider_timeout" || reason === "provider_unavailable") {
    return fallbackReplyFor(
      agent,
      "escalation",
      "I am having trouble responding right now. Let me connect you with our team."
    );
  }
  if (reason === "tool_timeout") {
    return fallbackReplyFor(
      agent,
      "escalation",
      "I am having trouble completing that request right now. Let me connect you with our team."
    );
  }
  return fallbackReplyFor(
    agent,
    "escalation",
    "I am unable to continue this chat automatically right now. Let me connect you with our team."
  );
}

async function findOrCreateWhatsappConversation({ workspaceId, agentId, contactId, conversation, now }) {
  return AiConversation.findOneAndUpdate(
    {
      workspaceId,
      agentId,
      contactId: contactId || null,
      channel: "whatsapp",
      deletedAt: null,
    },
    {
      $setOnInsert: {
        workspaceId,
        agentId,
        contactId: contactId || null,
        channel: "whatsapp",
        status: "active",
        messages: [],
        metadata: {
          source: "inbox",
          phone: conversation.phone || "",
          wabaId: conversation.wabaId || null,
          phoneNumberId: conversation.phoneNumberId || null,
          conversationId: String(conversation._id),
        },
      },
      $set: {
        lastMessageAt: now,
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true }
  );
}

async function appendInboundMessage({ workspaceId, aiConversation, inboundText, inboundMessage }) {
  const inboundMessageId = inboundMessage?._id ? String(inboundMessage._id) : "";
  if (inboundMessageId) {
    const existing = await AiConversation.findOne({
      _id: aiConversation._id,
      workspaceId,
      deletedAt: null,
      "messages.metadata.inboundMessageId": inboundMessageId,
    }).select("_id");
    if (existing) {
      return AiConversation.findOne({
        _id: aiConversation._id,
        workspaceId,
        deletedAt: null,
      });
    }
  }
  const now = inboundMessage?.receivedAt || new Date();
  const updated = await AiConversation.findOneAndUpdate(
    { _id: aiConversation._id, workspaceId, deletedAt: null },
    {
      $push: {
        messages: {
          role: "user",
          text: inboundText,
          metadata: {
            channel: "whatsapp",
            messageId: inboundMessage?._id ? String(inboundMessage._id) : null,
            whatsappMessageId: inboundMessage?.whatsappMessageId || null,
            inboundMessageId: inboundMessage?._id ? String(inboundMessage._id) : null,
          },
          createdAt: now,
        },
      },
      $set: { lastMessageAt: now, status: "active" },
    },
    { returnDocument: "after", runValidators: true }
  );
  return aiMemoryService.recentMessages(updated) ? updated : updated;
}

async function appendAssistantMessage({ workspaceId, aiConversation, reply, metadata, now, status }) {
  const executionKey = String(metadata?.executionKey || "").trim();
  if (executionKey) {
    const existing = await AiConversation.findOne({
      _id: aiConversation._id,
      workspaceId,
      deletedAt: null,
      "messages.metadata.executionKey": executionKey,
    }).select("_id");
    if (existing) {
      return AiConversation.findOne({
        _id: aiConversation._id,
        workspaceId,
        deletedAt: null,
      });
    }
  }
  const updatedConversation = await AiConversation.findOneAndUpdate(
    { _id: aiConversation._id, workspaceId, deletedAt: null },
    {
      $push: {
        messages: {
          role: "assistant",
          text: reply,
          metadata,
          createdAt: now,
        },
      },
      $set: {
        lastMessageAt: now,
        status: status || "active",
      },
    },
    { returnDocument: "after", runValidators: true }
  );
  return aiMemoryService.captureConversationMemory({
    workspaceId,
    conversation: updatedConversation,
    assistantMessage: reply,
  });
}

async function hasActiveFlowSession({ workspaceId, contactId }) {
  if (!contactId) return false;
  const active = await FlowSession.findOne({
    workspaceId,
    contactId,
    status: "active",
  })
    .select("_id")
    .lean();
  return Boolean(active?._id);
}

async function markConversationError({ workspaceId, conversationId, error }) {
  await Conversation.updateOne(
    { _id: conversationId, workspaceId },
    {
      $set: {
        aiLastErrorAt: new Date(),
        aiLastErrorMessage: String(error?.message || "AI runtime failed").slice(0, 500),
      },
    }
  ).catch(() => {});
}

async function updateAgentStats(agentId, patch) {
  if (!agentId) return;
  await AiAgent.updateOne({ _id: agentId }, patch).catch(() => {});
}

async function handleRetryExhaustedJob({
  workspaceId,
  conversationId,
  messageId,
  executionKey,
  error,
  attemptsMade = 0,
  maxAttempts = 0,
}) {
  if (!isRetryableRuntimeError(error)) {
    throw error;
  }
  const fallbackReason = fallbackReasonForError(error);

  const workspaceObjectId = asObjectId(workspaceId);
  const conversationObjectId = asObjectId(conversationId);
  const messageObjectId = asObjectId(messageId);
  if (!workspaceObjectId || !conversationObjectId || !messageObjectId) {
    return { success: false, skipped: "invalid_retry_exhausted_payload" };
  }

  let lockHandle = null;
  try {
    lockHandle = await acquireConversationLock({
      workspaceId: workspaceObjectId,
      conversationId: conversationObjectId,
      messageId: String(messageObjectId),
      executionKey,
      lockMs: LOCK_WINDOW_MS,
    });
  } catch (lockError) {
    if (isRetryableRuntimeError(lockError)) {
      const replyAt = new Date();
      await Conversation.updateOne(
        { _id: conversationObjectId, workspaceId: workspaceObjectId },
        {
          $set: {
            aiState: AI_STATES.HANDOVER_PENDING,
            aiHandoverAt: replyAt,
            aiHandoverReason: fallbackReason,
            aiLastErrorAt: replyAt,
            aiLastErrorMessage: String(error?.message || "AI runtime retry exhausted").slice(0, 500),
          },
        }
      ).catch(() => {});
      await Message.updateOne(
        { _id: messageObjectId, workspaceId: workspaceObjectId, direction: "inbound" },
        {
          $set: {
            aiProcessedAt: replyAt,
            aiStatus: "handover",
            aiAction: "handover",
            aiReason: fallbackReason,
            aiError: String(error?.message || "AI runtime retry exhausted").slice(0, 500),
            aiExecutionKey: String(executionKey || "").trim() || null,
          },
        }
      ).catch(() => {});
      return {
        success: true,
        action: "handover",
        reason: fallbackReason,
        skipped: "retry_exhausted_lock_busy_handover",
        attemptsMade,
        maxAttempts,
      };
    }
    throw lockError;
  }
  try {
    const [conversation, inboundMessage] = await Promise.all([
      Conversation.findOne({ _id: conversationObjectId, workspaceId: workspaceObjectId }),
      Message.findOne({ _id: messageObjectId, workspaceId: workspaceObjectId, direction: "inbound" }),
    ]);
    if (!conversation || !inboundMessage) {
      return { success: true, skipped: "retry_exhausted_target_missing" };
    }
    if (["replied", "handover", "skipped"].includes(String(inboundMessage.aiStatus || ""))) {
      return { success: true, skipped: "retry_exhausted_already_processed" };
    }

    const contact = await Contact.findOne({
      workspaceId: workspaceObjectId,
      wabaId: conversation.wabaId || null,
      phone: conversation.phone,
    }).lean();
    const agent = await resolveAgent({ workspaceId: workspaceObjectId, conversation });
    const resolvedExecutionKey = String(
      executionKey ||
        inboundMessage.aiExecutionKey ||
        buildExecutionKey({
          workspaceId: String(workspaceObjectId),
          inboundMessageId: String(inboundMessage._id),
          inboundWhatsappMessageId: inboundMessage.whatsappMessageId || "",
          phone: inboundMessage.phone || conversation.phone || "",
        })
    ).trim();
    const replyAt = new Date();
    let aiConversation = null;
    if (agent) {
      aiConversation = await findOrCreateWhatsappConversation({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        contactId: contact?._id || null,
        conversation,
        now: replyAt,
      });
    }

    const fallbackReply = fallbackReplyForRuntimeError(agent, error);
    let outbound = null;
    if (!error?.outboundFailure && fallbackReply) {
      outbound = await sendTextMessageForUser({
        userId: workspaceObjectId,
        contactId: contact?._id || undefined,
        to: conversation.phone,
        text: fallbackReply,
        idempotencyKey: buildOutboundReplyIdempotencyKey(`${resolvedExecutionKey}:fallback`),
        sentBy: { kind: "system" },
        source: "automation",
        senderType: "automation",
        triggeredByMessageId: inboundMessage.whatsappMessageId || null,
      }).catch(() => null);
    }

    if (aiConversation && fallbackReply) {
      await appendAssistantMessage({
        workspaceId: workspaceObjectId,
        aiConversation,
        reply: fallbackReply,
        metadata: {
          provider: "system",
          model: "retry-exhausted-fallback",
          confidence: 0,
          action: "handover",
          reason: fallbackReason,
          executionKey: `${resolvedExecutionKey}:fallback`,
          retry: {
            attemptsMade,
            maxAttempts,
          },
        },
        now: replyAt,
        status: "handover",
      });
    }

    const usageTransaction = await AiCreditTransaction.findOne({
      workspaceId: workspaceObjectId,
      executionKey: resolvedExecutionKey,
      type: "usage",
    })
      .select("credits tokens metadata balanceAfter")
      .lean();

    await aiRuntimeRepository.createUsageLog({
      workspaceId: workspaceObjectId,
      agentId: agent?._id || conversation.aiAgentId || null,
      conversationId: aiConversation?._id || conversation.aiConversationId || null,
      provider: "system",
      model: "retry-exhausted-fallback",
      executionKey: resolvedExecutionKey,
      inputTokens: Number(usageTransaction?.metadata?.inputTokens || 0),
      outputTokens: Number(usageTransaction?.metadata?.outputTokens || 0),
      totalTokens: Number(usageTransaction?.tokens || 0),
      creditsUsed: Number(usageTransaction?.credits || 0),
      estimatedCost: 0,
      latencyMs: 0,
      status: "failed",
      action: "handover",
      metadata: buildUsageMetadata({
        executionKey: resolvedExecutionKey,
        metadata: {
          channel: "whatsapp",
          reason: fallbackReason,
          inboundMessageId: String(inboundMessage._id),
          attemptsMade,
          maxAttempts,
          retryExhausted: true,
          originalError: {
            code: error?.code || null,
            message: String(error?.message || "AI runtime retry exhausted"),
          },
        },
      }),
    }, {
      mergeOnExisting: true,
      mergeFields: {
        status: "failed",
        action: "handover",
        error: {
          code: error?.code || null,
          message: String(error?.message || "AI runtime retry exhausted").slice(0, 500),
        },
        "metadata.retryExhausted": true,
        "metadata.retryExhaustedReason": fallbackReason,
        "metadata.retryExhaustedAttemptsMade": attemptsMade,
        "metadata.retryExhaustedMaxAttempts": maxAttempts,
        "metadata.retryExhaustedAt": replyAt,
      },
    }).catch(() => {});

    await Conversation.updateOne(
      { _id: conversation._id, workspaceId: workspaceObjectId },
      {
        $set: {
          aiState: AI_STATES.HANDOVER_PENDING,
          aiLastReplyAt: outbound?.message ? replyAt : conversation.aiLastReplyAt || null,
          aiHandoverAt: replyAt,
          aiHandoverReason: fallbackReason,
          aiLastErrorAt: replyAt,
          aiLastErrorMessage: String(error?.message || "AI runtime retry exhausted").slice(0, 500),
        },
      }
    ).catch(() => {});

    await Message.updateOne(
      { _id: inboundMessage._id, workspaceId: workspaceObjectId },
      {
        $set: {
          aiProcessedAt: replyAt,
          aiStatus: "handover",
          aiAction: "handover",
          aiReason: fallbackReason,
          aiReplyMessageId: outbound?.message?._id || null,
          aiError: String(error?.message || "AI runtime retry exhausted").slice(0, 500),
          aiExecutionKey: resolvedExecutionKey,
        },
      }
    ).catch(() => {});

    await writeConversationEvent({
      workspaceId: workspaceObjectId,
      conversationId: conversation._id,
      phone: conversation.phone,
      type: "ai_retry_exhausted_fallback",
      actor: { kind: "system" },
      payload: {
        reason: fallbackReason,
        attemptsMade,
        maxAttempts,
        aiAgentId: agent?._id ? String(agent._id) : null,
        aiConversationId: aiConversation?._id ? String(aiConversation._id) : null,
        errorCode: error?.code || null,
      },
    }).catch(() => {});

    return {
      success: true,
      action: "handover",
      reason: fallbackReason,
      attemptsMade,
      maxAttempts,
      fallbackSent: Boolean(outbound?.message?._id),
    };
  } finally {
    if (lockHandle) {
      await releaseConversationLock(lockHandle).catch(() => {});
    }
  }
}

async function processInboundJob({
  workspaceId,
  conversationId,
  messageId,
  executionKey,
}) {
  const workspaceObjectId = asObjectId(workspaceId);
  const conversationObjectId = asObjectId(conversationId);
  const messageObjectId = asObjectId(messageId);
  let runtimeExecutionKey = String(executionKey || "").trim() || null;
  if (!workspaceObjectId || !conversationObjectId || !messageObjectId) {
    return { success: false, skipped: "invalid_payload" };
  }

  const workspace = await Workspace.findOne({
    _id: workspaceObjectId,
    aiAgentEnabled: true,
    isActive: true,
    status: "active",
  })
    .select("_id aiAgentEnabled aiRemainingCredits aiRemainingTokens timezone")
    .lean();
  if (!workspace?.aiAgentEnabled) {
    logRuntimeSkip({
      workspaceId: workspaceObjectId,
      conversationId: conversationObjectId,
      messageId: messageObjectId,
      executionKey: runtimeExecutionKey,
      reason: "ai_disabled",
    });
    return { success: true, skipped: "ai_disabled" };
  }

  const conversationLock = await acquireConversationLock({
    workspaceId: workspaceObjectId,
    conversationId: conversationObjectId,
    messageId: String(messageObjectId),
    executionKey: runtimeExecutionKey,
    lockMs: LOCK_WINDOW_MS,
  });
  let lockHeartbeat = null;
  let lockLost = false;
  let typingIndicator = null;
  const maintainLock = async () => {
    const extended = await extendConversationLock(conversationLock).catch(() => ({ extended: false }));
    if (!extended?.extended) {
      lockLost = true;
    }
    return extended;
  };
  const assertLockActive = () => {
    if (!lockLost) return;
    const error = new Error("AI conversation lock lost during processing");
    error.code = "AI_CONVERSATION_LOCK_LOST";
    error.retryable = true;
    throw error;
  };
  lockHeartbeat = setInterval(() => {
    void maintainLock();
  }, LOCK_REFRESH_MS);
  if (typeof lockHeartbeat.unref === "function") lockHeartbeat.unref();

  try {
    assertLockActive();
    const lockedConversation = await Conversation.findOne({
      _id: conversationObjectId,
      workspaceId: workspaceObjectId,
    });
    if (!lockedConversation) {
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: conversationObjectId,
        messageId: messageObjectId,
        executionKey: runtimeExecutionKey,
        reason: "conversation_missing",
      });
      return { success: true, skipped: "conversation_missing" };
    }
    const normalizedAiState = normalizeAiState(lockedConversation.aiState, { fallback: null });
    if (
      normalizedAiState === AI_STATES.HUMAN_ACTIVE ||
      normalizedAiState === AI_STATES.PAUSED ||
      normalizedAiState === AI_STATES.CLOSED ||
      lockedConversation.automationPausedAt
    ) {
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: messageObjectId,
        executionKey: runtimeExecutionKey,
        reason: lockedConversation.automationPausedAt ? "automation_paused" : "human_or_paused",
      });
      return { success: true, skipped: "human_or_paused" };
    }

    let inboundMessage = await Message.findOne({
      _id: messageObjectId,
      workspaceId: workspaceObjectId,
      direction: "inbound",
    });
    if (!inboundMessage) {
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: messageObjectId,
        executionKey: runtimeExecutionKey,
        reason: "message_missing",
      });
      return { success: true, skipped: "message_missing" };
    }
    const normalizedExecutionKey = String(
      runtimeExecutionKey ||
        inboundMessage.aiExecutionKey ||
        buildExecutionKey({
          workspaceId: String(workspaceObjectId),
          inboundMessageId: String(inboundMessage._id),
          inboundWhatsappMessageId: inboundMessage.whatsappMessageId || "",
          phone: inboundMessage.phone || lockedConversation.phone || "",
        })
    ).trim();
    runtimeExecutionKey = normalizedExecutionKey;
    if (["replied", "handover", "skipped"].includes(String(inboundMessage.aiStatus || ""))) {
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: inboundMessage._id,
        executionKey: runtimeExecutionKey,
        reason: "already_processed",
      });
      return { success: true, skipped: "already_processed" };
    }
    inboundMessage = await Message.findOneAndUpdate(
      {
        _id: inboundMessage._id,
        workspaceId: workspaceObjectId,
        direction: "inbound",
        $or: [
          { aiExecutionKey: null },
          { aiExecutionKey: "" },
          { aiExecutionKey: normalizedExecutionKey },
        ],
      },
      {
        $set: {
          aiExecutionKey: normalizedExecutionKey,
          aiExecutionStartedAt: new Date(),
          aiStatus: "processing",
          aiError: null,
          aiReason: null,
        },
      },
      { returnDocument: "after" }
    );
    if (!inboundMessage) {
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: messageObjectId,
        executionKey: runtimeExecutionKey,
        reason: "execution_claim_mismatch",
      });
      return { success: true, skipped: "execution_claim_mismatch" };
    }
    const outboundReplyIdempotencyKey = buildOutboundReplyIdempotencyKey(normalizedExecutionKey);

    const inboundText = String(
      inboundMessage.text ||
      inboundMessage.buttonReply?.title ||
      inboundMessage.listReply?.title ||
      ""
    ).trim();
    if (!inboundText) {
      await markInboundMessageSkipped({
        workspaceId: workspaceObjectId,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "empty_message",
      });
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "empty_message",
      });
      return { success: true, skipped: "empty_message" };
    }

    const contact = await Contact.findOne({
      workspaceId: workspaceObjectId,
      wabaId: lockedConversation.wabaId || null,
      phone: lockedConversation.phone,
    }).lean();

    if (await hasActiveFlowSession({ workspaceId: workspaceObjectId, contactId: contact?._id || null })) {
      await markInboundMessageSkipped({
        workspaceId: workspaceObjectId,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "active_flow_session",
      });
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "active_flow_session",
      });
      return { success: true, skipped: "active_flow_session" };
    }

    const agent = await resolveAgentForMessage({
      workspaceId: workspaceObjectId,
      conversation: lockedConversation,
      message: inboundText,
      channel: "whatsapp",
    });
    if (!agent) {
      await markInboundMessageSkipped({
        workspaceId: workspaceObjectId,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "no_active_agent",
      });
      logRuntimeSkip({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        messageId: inboundMessage._id,
        executionKey: normalizedExecutionKey,
        reason: "no_active_agent",
      });
      return { success: true, skipped: "no_active_agent" };
    }

    const now = new Date();
    let aiConversation = await findOrCreateWhatsappConversation({
      workspaceId: workspaceObjectId,
      agentId: agent._id,
      contactId: contact?._id || null,
      conversation: lockedConversation,
      now,
    });

    await Conversation.updateOne(
      { _id: lockedConversation._id, workspaceId: workspaceObjectId },
      {
        $set: {
          aiAgentId: agent._id,
          aiConversationId: aiConversation._id,
          aiState: AI_STATES.AI_ACTIVE,
          aiLastInboundAt: inboundMessage.receivedAt || now,
        },
      }
    ).catch(() => {});
    await Message.updateOne(
      { _id: inboundMessage._id, workspaceId: workspaceObjectId },
      {
        $set: {
          aiAgentId: agent._id,
          aiConversationId: aiConversation._id,
          aiExecutionKey: normalizedExecutionKey,
        },
      }
    ).catch(() => {});

    aiConversation = await appendInboundMessage({
      workspaceId: workspaceObjectId,
      aiConversation,
      inboundText,
      inboundMessage,
    });
    aiConversation = await aiMemoryService.captureConversationMemory({
      workspaceId: workspaceObjectId,
      conversation: aiConversation,
      contact,
      userMessage: inboundText,
    });

    typingIndicator = createTypingIndicatorController({
      workspaceId: workspaceObjectId,
      inboundWhatsappMessageId: inboundMessage.whatsappMessageId || null,
    });

    const aiLimits = await getWorkspaceAiLimits(workspaceObjectId);

    const conversationMessages = aiMemoryService.recentMessages(aiConversation);
    const conversationSummary = aiMemoryService.conversationSummary(aiConversation);
    const conversationMemoryProfile = aiMemoryService.conversationMemory(aiConversation);
    let knowledgeChunks = await aiKnowledgeService.searchKnowledge({
      workspaceId: workspaceObjectId,
      agentId: agent._id,
      agent,
      query: inboundText,
      limit: 4,
    });

    let promptPayload = aiPromptBuilder.buildRuntimePrompt({
      agent,
      contact,
      conversationMessages,
      conversationSummary,
      conversationMemoryProfile,
      knowledgeChunks,
      userMessage: inboundText,
    });
    const managedFileSearch = aiManagedFileSearchService.getAgentStoreConfig(agent);

    const startedAt = Date.now();
    const businessHours = evaluateBusinessHours({
      agent,
      workspaceTimezone: workspace.timezone || "Asia/Calcutta",
      now,
    });
    if (businessHours.enabled && !businessHours.withinHours) {
      const afterHoursReply = fallbackReplyFor(
        agent,
        "afterHours",
        agent.guardrails?.fallbackMessage || "Our team is currently outside business hours. We will get back to you soon."
      );
      const replyAt = new Date();
      const shouldSendReply = businessHours.action !== "pause";
      if (shouldSendReply) {
        await appendAssistantMessage({
          workspaceId: workspaceObjectId,
          aiConversation,
          reply: afterHoursReply,
          metadata: {
            provider: "business_hours",
            model: "schedule-policy",
            confidence: 1,
            action: "handover",
            reason: "after_hours",
            executionKey: normalizedExecutionKey,
          },
          now: replyAt,
          status: "handover",
        });
      }
      const outbound = shouldSendReply
        ? await sendTextMessageForUser({
            userId: workspaceObjectId,
            contactId: contact?._id || undefined,
            to: lockedConversation.phone,
            text: afterHoursReply,
            idempotencyKey: outboundReplyIdempotencyKey,
            sentBy: { kind: "system" },
            source: "automation",
            senderType: "automation",
            triggeredByMessageId: inboundMessage.whatsappMessageId || null,
          })
        : null;
      const slaMinutes = Number(
        agent.runtimeControls?.conversationSla?.firstResponseMinutes ||
          agent.runtimeControls?.escalationRules?.slaMinutes ||
          30
      );
      await aiRuntimeRepository.createUsageLog({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        conversationId: aiConversation._id,
        provider: "business_hours",
        model: "schedule-policy",
        executionKey: normalizedExecutionKey,
        inputTokens: aiProviderService.estimateTokens(inboundText),
        outputTokens: aiProviderService.estimateTokens(afterHoursReply),
        totalTokens: aiProviderService.estimateTokens(`${inboundText}\n${afterHoursReply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
        action: "handover",
        metadata: buildUsageMetadata({
          executionKey: normalizedExecutionKey,
          metadata: {
          channel: "whatsapp",
          reason: "after_hours",
          businessHours,
          inboundMessageId: String(inboundMessage._id),
          },
        }),
      });
      await Conversation.updateOne(
        { _id: lockedConversation._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiLastReplyAt: shouldSendReply ? replyAt : null,
            aiState: businessHours.action === "pause" ? AI_STATES.PAUSED : AI_STATES.HANDOVER_PENDING,
            aiBusinessHoursStatus: "after_hours",
            aiHandoverAt: replyAt,
            aiHandoverReason: "after_hours",
            aiEscalatedAt: replyAt,
            aiEscalationLevel: 1,
            aiEscalationReason: "after_hours",
            aiSlaDueAt: new Date(replyAt.getTime() + slaMinutes * 60 * 1000),
            aiLastErrorAt: null,
            aiLastErrorMessage: null,
          },
        }
      ).catch(() => {});
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_after_hours",
        actor: { kind: "system" },
        payload: {
          aiAgentId: String(agent._id),
          aiConversationId: String(aiConversation._id),
          businessHours,
        },
      }).catch(() => {});
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_sla_started",
        actor: { kind: "system" },
        payload: {
          aiAgentId: String(agent._id),
          dueAt: new Date(replyAt.getTime() + slaMinutes * 60 * 1000),
          reason: "after_hours",
        },
      }).catch(() => {});
      await Message.updateOne(
        { _id: inboundMessage._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiProcessedAt: replyAt,
            aiStatus: "handover",
            aiAction: "handover",
            aiReason: "after_hours",
            aiReplyMessageId: outbound?.message?._id || null,
            aiError: null,
            aiExecutionKey: normalizedExecutionKey,
          },
        }
      ).catch(() => {});
      await updateAgentStats(agent._id, {
        $inc: { "stats.messages": 1, "stats.handovers": 1 },
        $set: { "stats.lastUsedAt": replyAt },
      });
      return { success: true, action: "handover" };
    }

    const escalationKeyword = escalationKeywordMatched(agent, inboundText);
    if (agent.runtimeControls?.escalationRules?.enabled && escalationKeyword) {
      const escalationReply = fallbackReplyFor(
        agent,
        "escalation",
        agent.guardrails?.fallbackMessage || "I am escalating this conversation to our human team."
      );
      const replyAt = new Date();
      await appendAssistantMessage({
        workspaceId: workspaceObjectId,
        aiConversation,
        reply: escalationReply,
        metadata: {
          provider: "escalation",
          model: "keyword-rule",
          confidence: 1,
          action: "handover",
          reason: `escalation_keyword:${escalationKeyword}`,
          executionKey: normalizedExecutionKey,
        },
        now: replyAt,
        status: "handover",
      });
      const outbound = await sendTextMessageForUser({
        userId: workspaceObjectId,
        contactId: contact?._id || undefined,
        to: lockedConversation.phone,
        text: escalationReply,
        idempotencyKey: outboundReplyIdempotencyKey,
        sentBy: { kind: "system" },
        source: "automation",
        senderType: "automation",
        triggeredByMessageId: inboundMessage.whatsappMessageId || null,
      });
      const slaMinutes = Number(agent.runtimeControls?.escalationRules?.slaMinutes || 30);
      await aiRuntimeRepository.createUsageLog({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        conversationId: aiConversation._id,
        provider: "escalation",
        model: "keyword-rule",
        executionKey: normalizedExecutionKey,
        inputTokens: aiProviderService.estimateTokens(inboundText),
        outputTokens: aiProviderService.estimateTokens(escalationReply),
        totalTokens: aiProviderService.estimateTokens(`${inboundText}\n${escalationReply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
        action: "handover",
        metadata: buildUsageMetadata({
          executionKey: normalizedExecutionKey,
          metadata: {
          channel: "whatsapp",
          reason: `escalation_keyword:${escalationKeyword}`,
          inboundMessageId: String(inboundMessage._id),
          },
        }),
      });
      await Conversation.updateOne(
        { _id: lockedConversation._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiLastReplyAt: replyAt,
            aiState: AI_STATES.HANDOVER_PENDING,
            aiBusinessHoursStatus: "within_hours",
            aiHandoverAt: replyAt,
            aiHandoverReason: `escalation_keyword:${escalationKeyword}`,
            aiEscalatedAt: replyAt,
            aiEscalationLevel: 1,
            aiEscalationReason: `keyword:${escalationKeyword}`,
            aiSlaDueAt: new Date(replyAt.getTime() + slaMinutes * 60 * 1000),
            aiLastErrorAt: null,
            aiLastErrorMessage: null,
          },
        }
      ).catch(() => {});
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_escalated",
        actor: { kind: "system" },
        payload: {
          aiAgentId: String(agent._id),
          aiConversationId: String(aiConversation._id),
          keyword: escalationKeyword,
        },
      }).catch(() => {});
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_sla_started",
        actor: { kind: "system" },
        payload: {
          aiAgentId: String(agent._id),
          dueAt: new Date(replyAt.getTime() + slaMinutes * 60 * 1000),
          reason: `keyword:${escalationKeyword}`,
        },
      }).catch(() => {});
      await Message.updateOne(
        { _id: inboundMessage._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiProcessedAt: replyAt,
            aiStatus: "handover",
            aiAction: "handover",
            aiReason: `escalation_keyword:${escalationKeyword}`,
            aiReplyMessageId: outbound?.message?._id || null,
            aiError: null,
            aiExecutionKey: normalizedExecutionKey,
          },
        }
      ).catch(() => {});
      await updateAgentStats(agent._id, {
        $inc: { "stats.messages": 1, "stats.handovers": 1 },
        $set: { "stats.lastUsedAt": replyAt },
      });
      return { success: true, action: "handover" };
    }

    const preCheck = aiGuardrailService.preCheckUserMessage({
      agent,
      userMessage: inboundText,
      conversation: aiConversation,
      contact,
    });

    if (!preCheck.passed) {
      const replyAt = new Date();
      await appendAssistantMessage({
        workspaceId: workspaceObjectId,
        aiConversation,
        reply: preCheck.reply,
        metadata: {
          provider: "guardrail",
          model: "pre-check",
          confidence: preCheck.confidence,
          action: preCheck.action,
          reason: preCheck.reason,
          executionKey: normalizedExecutionKey,
        },
        now: replyAt,
        status: preCheck.action === "handover" ? "handover" : "active",
      });
      const outbound = await sendTextMessageForUser({
        userId: workspaceObjectId,
        contactId: contact?._id || undefined,
        to: lockedConversation.phone,
        text: preCheck.reply,
        idempotencyKey: outboundReplyIdempotencyKey,
        sentBy: { kind: "system" },
        source: "automation",
        senderType: "automation",
        triggeredByMessageId: inboundMessage.whatsappMessageId || null,
      });
      await aiRuntimeRepository.createUsageLog({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        conversationId: aiConversation._id,
        provider: "guardrail",
        model: "pre-check",
        executionKey: normalizedExecutionKey,
        inputTokens: aiProviderService.estimateTokens(inboundText),
        outputTokens: aiProviderService.estimateTokens(preCheck.reply),
        totalTokens: aiProviderService.estimateTokens(`${inboundText}\n${preCheck.reply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: preCheck.action === "blocked" ? "blocked" : "success",
        action: preCheck.action,
        metadata: buildUsageMetadata({
          executionKey: normalizedExecutionKey,
          metadata: {
          channel: "whatsapp",
          reason: preCheck.reason,
          inboundMessageId: String(inboundMessage._id),
          },
        }),
      });
      await Conversation.updateOne(
        { _id: lockedConversation._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiLastReplyAt: replyAt,
            aiState: preCheck.action === "handover" ? AI_STATES.HANDOVER_PENDING : AI_STATES.AI_ACTIVE,
            aiBusinessHoursStatus: "within_hours",
            aiHandoverAt: preCheck.action === "handover" ? replyAt : null,
            aiHandoverReason: preCheck.action === "handover" ? preCheck.reason : null,
            aiSlaDueAt:
              preCheck.action === "handover" && agent.runtimeControls?.conversationSla?.enabled
                ? new Date(replyAt.getTime() + Number(agent.runtimeControls?.conversationSla?.firstResponseMinutes || 15) * 60 * 1000)
                : null,
            aiLastErrorAt: null,
            aiLastErrorMessage: null,
          },
        }
      ).catch(() => {});
      if (preCheck.action === "handover") {
        await writeConversationEvent({
          workspaceId: workspaceObjectId,
          conversationId: lockedConversation._id,
          phone: lockedConversation.phone,
          type: "ai_handover_requested",
          actor: { kind: "system" },
          payload: {
            source: "precheck",
            reason: preCheck.reason || "handover",
            aiAgentId: String(agent._id),
            aiConversationId: String(aiConversation._id),
          },
        }).catch(() => {});
      }
      await Message.updateOne(
        { _id: inboundMessage._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiProcessedAt: replyAt,
            aiStatus: preCheck.action === "handover" ? "handover" : "replied",
            aiAction: preCheck.action,
            aiReason: preCheck.reason || null,
            aiReplyMessageId: outbound?.message?._id || null,
            aiError: null,
            aiExecutionKey: normalizedExecutionKey,
          },
        }
      ).catch(() => {});
      await updateAgentStats(agent._id, {
        $inc: {
          "stats.messages": 1,
          ...(preCheck.action === "handover" ? { "stats.handovers": 1 } : {}),
        },
        $set: { "stats.lastUsedAt": replyAt },
      });
      return { success: true, action: preCheck.action };
    }

    const hasConfiguredKnowledge = await aiKnowledgeService.hasIndexedKnowledge({
      workspaceId: workspaceObjectId,
      agentId: agent._id,
      agent,
    });
    const forceHandoverOnKnowledgeMiss = aiConversationStyleService.shouldForceHandoverOnKnowledgeMiss(inboundText);

    if (!knowledgeChunks.length && hasConfiguredKnowledge && !managedFileSearch?.storeName && !forceHandoverOnKnowledgeMiss) {
      const fallbackKnowledgeChunks = await aiKnowledgeService.getKnowledgeMissFallbackChunks({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        agent,
        limit: 3,
      });
      if (fallbackKnowledgeChunks.length) {
        knowledgeChunks = fallbackKnowledgeChunks;
        promptPayload = aiPromptBuilder.buildRuntimePrompt({
          agent,
          contact,
          conversationMessages,
          conversationSummary,
          conversationMemoryProfile,
          knowledgeChunks,
          userMessage: inboundText,
        });
      }
    }

    if (!knowledgeChunks.length && hasConfiguredKnowledge && !managedFileSearch?.storeName) {
      await typingIndicator?.start();
      const reply = fallbackReplyFor(
        agent,
        "noAnswer",
        agent.guardrails?.fallbackMessage || "I do not have enough verified knowledge to answer that. Let me connect you with our team."
      );
      const replyAt = new Date();
      await appendAssistantMessage({
        workspaceId: workspaceObjectId,
        aiConversation,
        reply,
        metadata: {
          provider: "knowledge_guard",
          model: "no-relevant-source",
          confidence: 0.2,
          action: "handover",
          reason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "no_relevant_knowledge",
          executionKey: normalizedExecutionKey,
        },
        now: replyAt,
        status: "handover",
      });
      const outbound = await sendTextMessageForUser({
        userId: workspaceObjectId,
        contactId: contact?._id || undefined,
        to: lockedConversation.phone,
        text: reply,
        idempotencyKey: outboundReplyIdempotencyKey,
        sentBy: { kind: "system" },
        source: "automation",
        senderType: "automation",
        triggeredByMessageId: inboundMessage.whatsappMessageId || null,
      });
      await aiRuntimeRepository.createUsageLog({
        workspaceId: workspaceObjectId,
        agentId: agent._id,
        conversationId: aiConversation._id,
        provider: "knowledge_guard",
        model: "no-relevant-source",
        executionKey: normalizedExecutionKey,
        inputTokens: aiProviderService.estimateTokens(inboundText),
        outputTokens: aiProviderService.estimateTokens(reply),
        totalTokens: aiProviderService.estimateTokens(`${inboundText}\n${reply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
        action: "handover",
        metadata: buildUsageMetadata({
          executionKey: normalizedExecutionKey,
          metadata: {
            channel: "whatsapp",
            reason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "no_relevant_knowledge",
            inboundMessageId: String(inboundMessage._id),
          },
        }),
      });
      await Conversation.updateOne(
        { _id: lockedConversation._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiLastReplyAt: replyAt,
            aiState: AI_STATES.HANDOVER_PENDING,
            aiBusinessHoursStatus: "within_hours",
            aiHandoverAt: replyAt,
            aiHandoverReason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "no_relevant_knowledge",
            aiSlaDueAt: agent.runtimeControls?.conversationSla?.enabled
              ? new Date(replyAt.getTime() + Number(agent.runtimeControls?.conversationSla?.firstResponseMinutes || 15) * 60 * 1000)
              : null,
            aiLastErrorAt: null,
            aiLastErrorMessage: null,
          },
        }
      ).catch(() => {});
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_handover_requested",
        actor: { kind: "system" },
        payload: {
          source: "knowledge_guard",
          reason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "no_relevant_knowledge",
          aiAgentId: String(agent._id),
          aiConversationId: String(aiConversation._id),
        },
      }).catch(() => {});
      await Message.updateOne(
        { _id: inboundMessage._id, workspaceId: workspaceObjectId },
        {
          $set: {
            aiProcessedAt: replyAt,
            aiStatus: "handover",
            aiAction: "handover",
            aiReason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "no_relevant_knowledge",
            aiReplyMessageId: outbound?.message?._id || null,
            aiError: null,
            aiExecutionKey: normalizedExecutionKey,
          },
        }
      ).catch(() => {});
      await updateAgentStats(agent._id, {
        $inc: { "stats.messages": 1, "stats.handovers": 1 },
        $set: { "stats.lastUsedAt": replyAt },
      });
      return { success: true, action: "handover" };
    }

    assertLockActive();
    await aiBillingService.ensureAiCredits({
      workspaceId: workspaceObjectId,
      minCredits: 1,
      executionKey: normalizedExecutionKey,
    });
    await maintainLock();
    assertLockActive();
    await typingIndicator?.start();
    const providerResult = await aiProviderService.generateResponse({
      workspaceId: workspaceObjectId,
      agent,
      userMessage: inboundText,
      knowledgeChunks,
      managedFileSearch,
      limits: aiLimits,
      ...promptPayload,
    });
    providerResult.raw = {
      ...(providerResult.raw || {}),
      knowledgeSourceCount: knowledgeChunks.length,
    };
    const plannedToolCall = aiToolService.parseToolCall(providerResult.reply);
    const toolExecution = plannedToolCall
      ? await aiToolService.executeRequestedTools({
          workspaceId: workspaceObjectId,
          agent,
          toolCalls: [plannedToolCall],
          context: {
            channel: "whatsapp",
            contact,
            contactId: contact?._id ? String(contact._id) : null,
            conversation: lockedConversation,
            conversationId: String(lockedConversation._id),
            phone: lockedConversation.phone,
            wabaId: lockedConversation.wabaId || null,
            phoneNumberId: lockedConversation.phoneNumberId || null,
          },
        })
      : null;
    const assistantReply = aiConversationStyleService.normalizeReplyForPolicy({
      reply: toolExecution?.publicReply || providerResult.reply,
      userMessage: inboundText,
      style: promptPayload.style,
    });
    const guardrail = aiGuardrailService.applyGuardrails({
      agent,
      userMessage: inboundText,
      reply: assistantReply,
      providerResult,
      conversation: aiConversation,
    });
    if (toolExecution?.action && toolExecution.action !== "reply") {
      guardrail.passed = false;
      guardrail.action = toolExecution.action;
      guardrail.reply = assistantReply;
      guardrail.reason = plannedToolCall?.name || "tool_action";
    }

    const inputTokens = Number(providerResult.usage?.inputTokens || 0);
    const outputTokens = Number(providerResult.usage?.outputTokens || 0);
    const creditsUsed = creditsForUsage(inputTokens, outputTokens);
    const billing = serializeBilling(await aiBillingService.deductAiCredits({
      workspaceId: workspaceObjectId,
      creditsUsed,
      meta: {
        executionKey: normalizedExecutionKey,
        agentId: String(agent._id),
        conversationId: String(aiConversation._id),
        provider: providerResult.provider,
        model: providerResult.model,
        inputTokens,
        outputTokens,
        channel: "whatsapp",
      },
    }));

    const replyAt = new Date();
    aiConversation = await appendAssistantMessage({
      workspaceId: workspaceObjectId,
      aiConversation,
      reply: guardrail.reply,
      metadata: {
        provider: providerResult.provider,
        model: providerResult.model,
        confidence: guardrail.confidence,
        action: guardrail.action,
        reason: guardrail.reason,
        toolExecution,
        executionKey: normalizedExecutionKey,
        sources: knowledgeChunks.map((chunk) => ({
          sourceId: chunk.sourceId,
          title: chunk.title,
          chunkId: chunk.chunkId,
        })),
        billing,
      },
      now: replyAt,
      status: guardrail.action === "handover" ? "handover" : "active",
    });

    await maintainLock();
    assertLockActive();
    const outbound = await sendTextMessageForUser({
      userId: workspaceObjectId,
      contactId: contact?._id || undefined,
      to: lockedConversation.phone,
      text: guardrail.reply,
      idempotencyKey: outboundReplyIdempotencyKey,
      sentBy: { kind: "system" },
      source: "automation",
      senderType: "automation",
      triggeredByMessageId: inboundMessage.whatsappMessageId || null,
    });

    await aiRuntimeRepository.createUsageLog({
      workspaceId: workspaceObjectId,
      agentId: agent._id,
      conversationId: aiConversation._id,
      provider: providerResult.provider,
      model: providerResult.model,
      executionKey: normalizedExecutionKey,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      creditsUsed,
      estimatedCost: 0,
      latencyMs: Date.now() - startedAt,
      status: guardrail.action === "blocked" ? "blocked" : "success",
      action: guardrail.action,
      metadata: buildUsageMetadata({
        executionKey: normalizedExecutionKey,
        metadata: {
        channel: "whatsapp",
        billing,
        inboundMessageId: String(inboundMessage._id),
        toolExecution,
        knowledgeChunks: knowledgeChunks.map((chunk) => ({
          sourceId: chunk.sourceId,
          title: chunk.title,
          score: chunk.score,
        })),
        },
      }),
    });

    const conversationUpdates = {
      aiLastReplyAt: replyAt,
      aiState: guardrail.action === "handover" ? AI_STATES.HANDOVER_PENDING : AI_STATES.AI_ACTIVE,
      aiBusinessHoursStatus: "within_hours",
      aiLastErrorAt: null,
      aiLastErrorMessage: null,
      aiConversationId: aiConversation._id,
      aiAgentId: agent._id,
    };
    if (guardrail.action === "handover") {
      conversationUpdates.aiHandoverAt = replyAt;
      conversationUpdates.aiHandoverReason = guardrail.reason || "handover";
      conversationUpdates.aiSlaDueAt = agent.runtimeControls?.conversationSla?.enabled
        ? new Date(replyAt.getTime() + Number(agent.runtimeControls?.conversationSla?.firstResponseMinutes || 15) * 60 * 1000)
        : null;
    } else {
      conversationUpdates.aiHandoverAt = null;
      conversationUpdates.aiHandoverReason = null;
      conversationUpdates.aiSlaDueAt = null;
    }
    await Conversation.updateOne(
      { _id: lockedConversation._id, workspaceId: workspaceObjectId },
      { $set: conversationUpdates }
    ).catch(() => {});
    if (guardrail.action === "handover") {
      await writeConversationEvent({
        workspaceId: workspaceObjectId,
        conversationId: lockedConversation._id,
        phone: lockedConversation.phone,
        type: "ai_handover_requested",
        actor: { kind: "system" },
        payload: {
          source: "guardrail",
          reason: guardrail.reason || "handover",
          aiAgentId: String(agent._id),
          aiConversationId: String(aiConversation._id),
        },
      }).catch(() => {});
    }
    await Message.updateOne(
      { _id: inboundMessage._id, workspaceId: workspaceObjectId },
      {
        $set: {
          aiProcessedAt: replyAt,
          aiStatus: guardrail.action === "handover" ? "handover" : "replied",
          aiAction: guardrail.action,
          aiReason: guardrail.reason || null,
          aiReplyMessageId: outbound?.message?._id || null,
          aiError: null,
          aiExecutionKey: normalizedExecutionKey,
        },
      }
    ).catch(() => {});

    const agentStatsPatch = {
      $inc: {
        "stats.messages": 1,
        ...(guardrail.action === "handover" ? { "stats.handovers": 1 } : {}),
      },
      $set: { "stats.lastUsedAt": replyAt },
    };
    if (!aiConversation.metadata?.countedConversation) {
      agentStatsPatch.$inc["stats.conversations"] = 1;
      await AiConversation.updateOne(
        { _id: aiConversation._id, workspaceId: workspaceObjectId },
        { $set: { "metadata.countedConversation": true } }
      ).catch(() => {});
    }
    await updateAgentStats(agent._id, agentStatsPatch);

    return {
      success: true,
      action: guardrail.action,
      billing,
      conversationId: String(aiConversation._id),
    };
  } catch (error) {
    if (error?.code !== "AI_CONVERSATION_LOCK_BUSY") {
      await Message.updateOne(
        { _id: messageObjectId, workspaceId: workspaceObjectId, direction: "inbound" },
        {
          $set: {
            aiStatus: "failed",
            aiError: String(error?.message || "AI runtime failed").slice(0, 500),
            aiExecutionKey: runtimeExecutionKey,
          },
        }
      ).catch(() => {});
      await markConversationError({
        workspaceId: workspaceObjectId,
        conversationId: conversationObjectId,
        error,
      });
    }
    throw error;
  } finally {
    await typingIndicator?.stop();
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    await releaseConversationLock(conversationLock).catch(() => {});
  }
}

module.exports = {
  processInboundJob,
  handleRetryExhaustedJob,
};
