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
  const knowledgeChunks = await aiKnowledgeService.searchKnowledge({
    workspaceId,
    agentId,
    agent,
    query: message,
    limit: 5,
  });
  const promptPayload = aiPromptBuilder.buildRuntimePrompt({
    agent,
    contact,
    conversationMessages,
    conversationSummary,
    knowledgeChunks,
    userMessage: message,
  });
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
    if (!knowledgeChunks.length && hasConfiguredKnowledge) {
      const fallbackReply = agent.guardrails?.fallbackMessage || "I do not have enough verified knowledge to answer that. Let me connect you with our team.";
      const updatedConversation = await aiMemoryService.appendExchange({
        workspaceId,
        conversation,
        userMessage: message,
        assistantMessage: fallbackReply,
        metadata: {
          assistant: {
            provider: "knowledge_guard",
            model: "no-relevant-source",
            confidence: 0.2,
            action: "handover",
            guardrailReason: "no_relevant_knowledge",
            sources: [],
          },
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
        status: "blocked",
        action: "handover",
        metadata: {
          channel: "test",
          guardrailReason: "no_relevant_knowledge",
          sources: [],
        },
      });
      return {
        success: true,
        reply: fallbackReply,
        confidence: 0.2,
        action: "handover",
        guardrail: { passed: false, reason: "no_relevant_knowledge" },
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
      limits: aiLimits,
      ...promptPayload,
    });
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
    const assistantReply = toolExecution?.publicReply || providerResult.reply;
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
