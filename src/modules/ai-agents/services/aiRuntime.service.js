const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const aiRuntimeRepository = require("@modules/ai-agents/repositories/aiRuntime.repository");
const aiMemoryService = require("@modules/ai-agents/services/aiMemory.service");
const aiProviderService = require("@modules/ai-agents/services/aiProvider.service");
const aiPromptBuilder = require("@modules/ai-agents/services/aiPromptBuilder.service");
const aiGuardrailService = require("@modules/ai-agents/services/aiGuardrail.service");
const aiToolService = require("@modules/ai-agents/services/aiTool.service");
const aiBillingService = require("@modules/ai-agents/services/aiBilling.service");
const aiKnowledgeService = require("@modules/ai-agents/services/aiKnowledge.service");
const aiManagedFileSearchService = require("@modules/ai-agents/services/aiManagedFileSearch.service");
const aiConversationStyleService = require("@modules/ai-agents/services/aiConversationStyle.service");
const {
  tokensToCreditsExact,
  getWorkspaceAiLimits,
} = require("@modules/ai-agents/services/aiAddon.service");

function assertValidObjectId(value, label) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

function serializeUsage(log) {
  const value = typeof log?.toObject === "function" ? log.toObject() : log;
  if (!value) return null;
  return {
    ...value,
    id: String(value._id),
    _id: String(value._id),
    workspaceId: String(value.workspaceId),
    agentId: String(value.agentId),
    conversationId: value.conversationId ? String(value.conversationId) : null,
  };
}

function creditsForUsage(usage) {
  const totalTokens = Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
  return tokensToCreditsExact(totalTokens);
}

function serializeBilling(result) {
  if (!result) return null;
  return {
    enabled: Boolean(result.enabled),
    deducted: Boolean(result.deducted),
    creditsUsed: Number(result.creditsUsed || 0),
    remainingCredits: result.remainingCredits ?? null,
    remainingTokens: result.remainingTokens ?? null,
    currency: result.currency || null,
  };
}

async function testMessage({ workspaceId, agentId, payload }) {
  assertValidObjectId(agentId, "AI agent id");
  const message = String(payload?.message || "").trim();
  if (!message) throw new HttpError(400, "Message is required");
  const contactId = String(payload?.contactId || "").trim() || null;
  if (contactId) assertValidObjectId(contactId, "contact id");

  const agent = await aiAgentRepository.findById({ workspaceId, agentId });
  if (!agent) throw new HttpError(404, "AI agent not found");
  if (!["active", "draft"].includes(agent.status)) {
    throw new HttpError(409, "AI agent must be draft or active for test chat");
  }

  const [contact, conversation] = await Promise.all([
    aiRuntimeRepository.findContactById({ workspaceId, contactId }),
    aiMemoryService.getTestConversation({ workspaceId, agentId, contactId }),
  ]);
  if (contactId && !contact) throw new HttpError(404, "Contact not found");

  const conversationMessages = aiMemoryService.recentMessages(conversation);
  const conversationSummary = aiMemoryService.conversationSummary(conversation);
  const conversationMemoryProfile = aiMemoryService.conversationMemory(conversation);
  let knowledgeChunks = await aiKnowledgeService.searchKnowledge({
    workspaceId,
    agentId,
    agent,
    query: message,
    limit: 4,
  });
  let promptPayload = aiPromptBuilder.buildRuntimePrompt({
    agent,
    contact,
    conversationMessages,
    conversationSummary,
    conversationMemoryProfile,
    knowledgeChunks,
    userMessage: message,
  });
  const managedFileSearch = aiManagedFileSearchService.getAgentStoreConfig(agent);
  const startedAt = Date.now();
  const aiLimits = await getWorkspaceAiLimits(workspaceId);
  let providerResult;
  let guardrail;
  let usageLog;
  try {
    const preCheck = aiGuardrailService.preCheckUserMessage({
      agent,
      userMessage: message,
      conversation,
      contact,
    });
    if (!preCheck.passed) {
      const updatedConversation = await aiMemoryService.appendExchange({
        workspaceId,
        conversation,
        userMessage: message,
        assistantMessage: preCheck.reply,
        metadata: {
          assistant: {
            provider: "guardrail",
            model: "pre-check",
            confidence: preCheck.confidence,
          action: preCheck.action,
          guardrailReason: preCheck.reason,
        },
        contact,
      },
    });
      usageLog = await aiRuntimeRepository.createUsageLog({
        workspaceId,
        agentId,
        conversationId: conversation._id,
        provider: "guardrail",
        model: "pre-check",
        inputTokens: aiProviderService.estimateTokens(message),
        outputTokens: aiProviderService.estimateTokens(preCheck.reply),
        totalTokens: aiProviderService.estimateTokens(`${message}\n${preCheck.reply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: "blocked",
        action: preCheck.action,
        metadata: {
          channel: "test",
          guardrailReason: preCheck.reason,
          billing: { deducted: false, creditsUsed: 0 },
        },
      });
      return {
        success: true,
        reply: preCheck.reply,
        confidence: preCheck.confidence,
        action: preCheck.action,
        guardrail: {
          passed: false,
          reason: preCheck.reason,
        },
        provider: "guardrail",
        model: "pre-check",
        usage: serializeUsage(usageLog),
        conversation: aiMemoryService.serializeConversation(updatedConversation),
        tools: aiToolService.plannedTools(agent),
      };
    }

    const hasConfiguredKnowledge = await aiKnowledgeService.hasIndexedKnowledge({ workspaceId, agentId, agent });
    const forceHandoverOnKnowledgeMiss = aiConversationStyleService.shouldForceHandoverOnKnowledgeMiss(message);
    console.info("[ai-test-runtime] retrieval summary", {
      workspaceId: String(workspaceId),
      agentId: String(agentId),
      hasConfiguredKnowledge,
      knowledgeChunkCount: knowledgeChunks.length,
      managedFileSearchEnabled: Boolean(managedFileSearch?.storeName),
      intent: promptPayload.style?.intent || null,
      responseLength: promptPayload.style?.responseLength || null,
      forceHandoverOnKnowledgeMiss,
    });
    if (!knowledgeChunks.length && hasConfiguredKnowledge && !managedFileSearch?.storeName && !forceHandoverOnKnowledgeMiss) {
      const fallbackKnowledgeChunks = await aiKnowledgeService.getKnowledgeMissFallbackChunks({
        workspaceId,
        agentId,
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
          userMessage: message,
        });
      }
    }
    if (!knowledgeChunks.length && hasConfiguredKnowledge && !managedFileSearch?.storeName) {
      const fallbackReply = forceHandoverOnKnowledgeMiss
        ? agent.guardrails?.fallbackMessage || "I do not have enough verified knowledge to answer that. Let me connect you with our team."
        : aiConversationStyleService.buildKnowledgeMissClarifier({
            userMessage: message,
            style: promptPayload.style,
          });
      const fallbackAction = forceHandoverOnKnowledgeMiss ? "handover" : "reply";
      const updatedConversation = await aiMemoryService.appendExchange({
        workspaceId,
        conversation,
        userMessage: message,
        assistantMessage: fallbackReply,
        metadata: {
          assistant: {
            provider: "knowledge_guard",
            model: "no-relevant-source",
            confidence: forceHandoverOnKnowledgeMiss ? 0.2 : 0.58,
            action: fallbackAction,
            guardrailReason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "knowledge_clarification_needed",
            sources: [],
          },
          contact,
        },
      });
      usageLog = await aiRuntimeRepository.createUsageLog({
        workspaceId,
        agentId,
        conversationId: conversation._id,
        provider: "knowledge_guard",
        model: "no-relevant-source",
        inputTokens: aiProviderService.estimateTokens(message),
        outputTokens: aiProviderService.estimateTokens(fallbackReply),
        totalTokens: aiProviderService.estimateTokens(`${message}\n${fallbackReply}`),
        creditsUsed: 0,
        estimatedCost: 0,
        latencyMs: Date.now() - startedAt,
        status: forceHandoverOnKnowledgeMiss ? "blocked" : "success",
        action: fallbackAction,
        metadata: {
          channel: "test",
          guardrailReason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "knowledge_clarification_needed",
          sources: [],
        },
      });
      console.info("[ai-test-runtime] knowledge fallback used", {
        workspaceId: String(workspaceId),
        agentId: String(agentId),
        action: fallbackAction,
        reason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "knowledge_clarification_needed",
      });
      return {
        success: true,
        reply: fallbackReply,
        confidence: forceHandoverOnKnowledgeMiss ? 0.2 : 0.58,
        action: fallbackAction,
        guardrail: {
          passed: !forceHandoverOnKnowledgeMiss,
          reason: forceHandoverOnKnowledgeMiss ? "knowledge_miss_high_risk" : "knowledge_clarification_needed",
        },
        provider: "knowledge_guard",
        model: "no-relevant-source",
        usage: serializeUsage(usageLog),
        conversation: aiMemoryService.serializeConversation(updatedConversation),
        tools: aiToolService.plannedTools(agent),
        sources: [],
      };
    }

    await aiBillingService.ensureAiCredits({ workspaceId, minCredits: 1 });
    providerResult = await aiProviderService.generateResponse({
      workspaceId,
      agent,
      userMessage: message,
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
          workspaceId,
          agent,
          toolCalls: [plannedToolCall],
          context: {
            channel: "test",
            contact,
            contactId: contact?._id ? String(contact._id) : null,
            conversation,
            conversationId: conversation?._id ? String(conversation._id) : null,
          },
        })
      : null;
    const assistantReply = aiConversationStyleService.normalizeReplyForPolicy({
      reply: toolExecution?.publicReply || providerResult.reply,
      userMessage: message,
      style: promptPayload.style,
    });
    guardrail = aiGuardrailService.applyGuardrails({
      agent,
      userMessage: message,
      reply: assistantReply,
      providerResult,
      conversation,
    });
    if (toolExecution?.action && toolExecution.action !== "reply") {
      guardrail = {
        ...guardrail,
        passed: false,
        action: toolExecution.action,
        reply: assistantReply,
        reason: plannedToolCall?.name || "tool_action",
      };
    }
    const updatedConversation = await aiMemoryService.appendExchange({
      workspaceId,
      conversation,
      userMessage: message,
      assistantMessage: guardrail.reply,
      metadata: {
        assistant: {
          provider: providerResult.provider,
          model: providerResult.model,
          confidence: guardrail.confidence,
          action: guardrail.action,
          guardrailReason: guardrail.reason,
          sources: knowledgeChunks.map((chunk) => ({
            sourceId: chunk.sourceId,
            title: chunk.title,
            url: chunk.url,
            chunkId: chunk.chunkId,
          })),
        },
        contact,
      },
    });
    const inputTokens = Number(providerResult.usage?.inputTokens || 0);
    const outputTokens = Number(providerResult.usage?.outputTokens || 0);
    const creditsUsed = creditsForUsage({ inputTokens, outputTokens });
    const billing = serializeBilling(await aiBillingService.deductAiCredits({
      workspaceId,
      creditsUsed,
      meta: {
        agentId: String(agentId),
        conversationId: String(conversation._id),
        provider: providerResult.provider,
        model: providerResult.model,
        inputTokens,
        outputTokens,
        channel: "test",
      },
    }));
    usageLog = await aiRuntimeRepository.createUsageLog({
      workspaceId,
      agentId,
      conversationId: conversation._id,
      provider: providerResult.provider,
      model: providerResult.model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      creditsUsed,
      estimatedCost: 0,
      latencyMs: Date.now() - startedAt,
      status: guardrail.action === "blocked" ? "blocked" : "success",
      action: guardrail.action,
      metadata: {
        channel: "test",
        plannedTools: aiToolService.plannedTools(agent),
        plannedToolCall,
        knowledgeChunks: knowledgeChunks.map((chunk) => ({
          title: chunk.title,
          type: chunk.type,
          score: chunk.score,
          sourceId: chunk.sourceId,
        })),
        toolExecution,
        billing,
        providerRaw: providerResult.raw || null,
      },
    });
    console.info("[ai-test-runtime] reply decision", {
      workspaceId: String(workspaceId),
      agentId: String(agentId),
      provider: providerResult.provider,
      model: providerResult.model,
      action: guardrail.action,
      guardrailReason: guardrail.reason || null,
      knowledgeChunkCount: knowledgeChunks.length,
      managedFileSearchEnabled: Boolean(managedFileSearch?.storeName),
      finishReason: providerResult?.raw?.finishReason || null,
      repairedIncompleteReply: Boolean(providerResult?.raw?.repairedIncompleteReply),
      repairReason: providerResult?.raw?.repairReason || null,
    });
    return {
      success: true,
      reply: guardrail.reply,
      confidence: guardrail.confidence,
      action: guardrail.action,
      guardrail: {
        passed: guardrail.passed,
        reason: guardrail.reason,
      },
      provider: providerResult.provider,
      model: providerResult.model,
      usage: serializeUsage(usageLog),
      conversation: aiMemoryService.serializeConversation(updatedConversation),
      tools: aiToolService.plannedTools(agent),
      plannedToolCall,
      toolExecution,
      billing,
      sources: knowledgeChunks.map((chunk) => ({
        sourceId: chunk.sourceId,
        title: chunk.title,
        url: chunk.url,
        chunkId: chunk.chunkId,
      })),
    };
  } catch (error) {
    usageLog = await aiRuntimeRepository.createUsageLog({
      workspaceId,
      agentId,
      conversationId: conversation?._id || null,
      provider: "gemini",
      model: agent.modelName || "gemini-3.5-flash",
      inputTokens: aiProviderService.estimateTokens(promptPayload.prompt),
      outputTokens: 0,
      totalTokens: aiProviderService.estimateTokens(promptPayload.prompt),
      creditsUsed: 0,
      latencyMs: Date.now() - startedAt,
      status: "failed",
      action: "blocked",
      error: { message: error?.message || "AI runtime failed" },
      metadata: { channel: "test" },
    }).catch(() => null);
    throw new HttpError(502, error?.message || "AI runtime failed", {
      usage: serializeUsage(usageLog),
    });
  }
}

async function listConversations({ workspaceId, agentId }) {
  assertValidObjectId(agentId, "AI agent id");
  const agent = await aiAgentRepository.findById({ workspaceId, agentId });
  if (!agent) throw new HttpError(404, "AI agent not found");
  return {
    success: true,
    conversations: await aiMemoryService.listConversations({ workspaceId, agentId }),
  };
}

async function clearTestMemory({ workspaceId, agentId, payload }) {
  assertValidObjectId(agentId, "AI agent id");
  const contactId = String(payload?.contactId || "").trim() || null;
  if (contactId) assertValidObjectId(contactId, "contact id");
  await aiMemoryService.clearTestMemory({ workspaceId, agentId, contactId });
  return { success: true };
}

module.exports = {
  testMessage,
  listConversations,
  clearTestMemory,
};
