const { GoogleGenAI } = require("@google/genai");
const { HttpError } = require("@shared/utils/httpError");
const aiProviderConfigService = require("@modules/ai-agents/services/aiProviderConfig.service");
const aiProviderCircuitBreakerService = require("@modules/ai-agents/services/aiProviderCircuitBreaker.service");
const aiManagedFileSearchService = require("@modules/ai-agents/services/aiManagedFileSearch.service");
const {
  normalizeProviderError,
  isRetryableRuntimeError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30000);
const DEFAULT_RETRIES = Number(process.env.AI_PROVIDER_RETRIES || 2);
const DEFAULT_GEMINI_MODEL = aiProviderConfigService.DEFAULT_GEMINI_MODEL;
let geminiClient = null;
let geminiSdkInitLogged = false;

function logGeminiDebug(event, details = {}) {
  // eslint-disable-next-line no-console
  console.info(`[ai-provider] ${event}`, details);
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampPromptToTokenLimit(prompt, maxInputTokens) {
  const text = String(prompt || "");
  const maxChars = Math.max(200, Number(maxInputTokens || 4096) * 4);
  if (text.length <= maxChars) {
    return { prompt: text, truncated: false };
  }
  const headChars = Math.max(80, Math.floor(maxChars * 0.35));
  const tailChars = Math.max(80, maxChars - headChars - 64);
  const trimmed = `${text.slice(0, headChars)}\n\n[Earlier context trimmed to fit runtime limit]\n\n${text.slice(-tailChars)}`;
  return { prompt: trimmed, truncated: true };
}

function shrinkPromptForRetry(prompt, retryMaxTokens = 1800) {
  const text = String(prompt || "");
  const maxChars = Math.max(200, Number(retryMaxTokens || 2500) * 4);
  if (text.length <= maxChars) {
    return { prompt: text, reduced: false };
  }
  const headChars = Math.max(120, Math.floor(maxChars * 0.45));
  const tailChars = Math.max(120, maxChars - headChars - 72);
  const reducedPrompt = `${text.slice(0, headChars)}\n\n[Context reduced for provider retry]\n\n${text.slice(-tailChars)}`;
  return { prompt: reducedPrompt, reduced: true };
}

function sanitizeProviderText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n/g, "\n")
    .trim();
}

function getGeminiApiKey() {
  return String(
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    ""
  ).trim();
}

function getGeminiClient() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
    if (!geminiSdkInitLogged) {
      geminiSdkInitLogged = true;
      logGeminiDebug("Gemini SDK initialized", {
        transport: "@google/genai",
        apiKeySource: process.env.GOOGLE_API_KEY
          ? "GOOGLE_API_KEY"
          : process.env.GEMINI_API_KEY
            ? "GEMINI_API_KEY"
            : process.env.GOOGLE_AI_API_KEY
              ? "GOOGLE_AI_API_KEY"
              : "unknown",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        retries: DEFAULT_RETRIES,
        pid: process.pid,
        workerProcess: String(process.env.WORKER_PROCESS || "") === "true",
      });
    }
  }
  return geminiClient;
}

function buildGeminiRequestBody({ systemInstruction, prompt, agent }) {
  const sanitizedSystem = sanitizeProviderText(systemInstruction);
  const sanitizedPrompt = sanitizeProviderText(prompt);
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: sanitizedPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: resolveMaxOutputTokens(agent, 600),
    },
  };
  if (sanitizedSystem) {
    body.systemInstruction = {
      parts: [{ text: sanitizedSystem }],
    };
  }
  return body;
}

function resolveMaxOutputTokens(agent, fallback = 600) {
  return Math.max(1, Number(agent?.runtimeLimits?.maxTokensPerReply || fallback) || fallback);
}

async function withRetry(operation, { provider, maxRetries = DEFAULT_RETRIES } = {}) {
  let lastError;
  const attempts = Math.max(1, Number(maxRetries || 0) + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation(attempt);
      return {
        ...result,
        raw: {
          ...(result.raw || {}),
          provider,
          attempts: attempt,
        },
      };
    } catch (error) {
      lastError = normalizeProviderError(error, { provider });
      if (attempt >= attempts || !isRetryableRuntimeError(lastError)) break;
      await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function extractGeminiText(response) {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const parts = candidates[0]?.content?.parts || [];
  return parts.map((part) => part?.text || "").join("").trim();
}

function extractInteractionText(interaction) {
  const direct = String(interaction?.output_text || "").trim();
  if (direct) return direct;
  const textOutputs = Array.isArray(interaction?.outputs)
    ? interaction.outputs.filter((item) => item?.type === "text")
    : [];
  return textOutputs.map((item) => String(item?.text || "")).join("\n").trim();
}

function extractInteractionUsage(usage) {
  return {
    inputTokens: Number(usage?.total_input_tokens || 0),
    outputTokens: Number(usage?.total_output_tokens || 0),
    totalTokens: Number(usage?.total_tokens || 0),
  };
}

async function generateManualResponse({ agent, userMessage, prompt, knowledgeChunks }) {
  const knowledge = (knowledgeChunks || [])
    .map((source) => [source.title, source.text, source.url].filter(Boolean).join(" - "))
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
  const reply = knowledge
    ? `Test reply from ${agent.name}: I found this from your configured knowledge:\n${knowledge.slice(0, 700)}`
    : `Test reply from ${agent.name}: I received "${userMessage}". Add knowledge sources or connect Gemini for real AI replies.`;
  return {
    reply,
    provider: "manual",
    model: "manual-test",
    raw: null,
    usage: {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(reply),
    },
  };
}

async function generateGeminiInteractionResponse({
  workspaceId = null,
  agent,
  prompt,
  systemInstruction = "",
  managedFileSearch = null,
}) {
  const { model } = await aiProviderConfigService.resolveGeminiModel(
    agent.modelName || DEFAULT_GEMINI_MODEL,
    { allowFallback: true }
  );
  const startedAt = Date.now();
  return withRetry(async (attempt) => {
    const client = getGeminiClient();
    if (!client) {
      throw new HttpError(500, "Gemini client could not be initialized");
    }
    const retryPrompt =
      attempt > 1 ? shrinkPromptForRetry(prompt, 1800) : { prompt, reduced: false };
    logGeminiDebug("Gemini interactions attempt", {
      model,
      attempt,
      promptChars: String(retryPrompt.prompt || "").length,
      systemChars: String(systemInstruction || "").length,
      reducedPrompt: retryPrompt.reduced,
      workspaceId: workspaceId ? String(workspaceId) : null,
      agentId: agent?._id ? String(agent._id) : agent?.id ? String(agent.id) : null,
      fileSearchStore: managedFileSearch?.storeName || null,
    });
    const interaction = await Promise.race([
      client.interactions.create({
        model,
        input: sanitizeProviderText(retryPrompt.prompt),
        system_instruction: sanitizeProviderText(systemInstruction) || undefined,
        generation_config: {
          maxOutputTokens: resolveMaxOutputTokens(agent, 600),
        },
        tools: managedFileSearch?.storeName
          ? [
              {
                type: "file_search",
                fileSearchStoreNames: [managedFileSearch.storeName],
                topK: Number(managedFileSearch.topK || aiManagedFileSearchService.MANAGED_FILE_SEARCH_TOP_K || 4),
              },
            ]
          : undefined,
        labels: {
          channel: "ai-agent",
          workspace_id: workspaceId ? String(workspaceId) : "global",
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI provider timeout")), DEFAULT_TIMEOUT_MS)
      ),
    ]);
    const reply = extractInteractionText(interaction) || "I could not generate a response.";
    const usage = extractInteractionUsage(interaction?.usage);
    logGeminiDebug("Gemini interactions success", {
      model,
      attempt,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      replyChars: reply.length,
      fileSearchStore: managedFileSearch?.storeName || null,
    });
    return {
      reply,
      provider: "gemini",
      model,
      raw: {
        latencyMs: Date.now() - startedAt,
        retryPromptReduced: retryPrompt.reduced,
        interactionId: interaction?.id || null,
        interactionStatus: interaction?.status || null,
        managedFileSearch: {
          enabled: Boolean(managedFileSearch?.storeName),
          storeName: managedFileSearch?.storeName || null,
        },
      },
      usage: {
        inputTokens: usage.inputTokens || estimateTokens(retryPrompt.prompt),
        outputTokens: usage.outputTokens || estimateTokens(reply),
        totalTokens: usage.totalTokens || usage.inputTokens + usage.outputTokens,
      },
    };
  }, { provider: "gemini" });
}

async function generateGeminiResponse({
  workspaceId = null,
  agent,
  prompt,
  systemInstruction = "",
  managedFileSearch = null,
}) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw normalizeProviderError(new HttpError(500, "GEMINI_API_KEY is not configured"), {
      provider: "gemini",
      model: agent.modelName || DEFAULT_GEMINI_MODEL,
    });
  }
  const { model } = await aiProviderConfigService.resolveGeminiModel(agent.modelName || DEFAULT_GEMINI_MODEL, { allowFallback: true });
  await aiProviderCircuitBreakerService.beforeProviderRequest({
    workspaceId: workspaceId ? String(workspaceId) : "global",
    provider: "gemini",
    model,
  });
  const startedAt = Date.now();
  const requestPromise =
    managedFileSearch?.storeName
      ? generateGeminiInteractionResponse({
          workspaceId,
          agent,
          prompt,
          systemInstruction,
          managedFileSearch,
        })
      : withRetry(async (attempt) => {
          const client = getGeminiClient();
          if (!client) {
            throw new HttpError(500, "Gemini client could not be initialized");
          }
          const retryPrompt =
            attempt > 1
              ? shrinkPromptForRetry(prompt, 2500)
              : { prompt, reduced: false };
          logGeminiDebug("Gemini generateContent attempt", {
            model,
            attempt,
            promptChars: String(retryPrompt.prompt || "").length,
            systemChars: String(systemInstruction || "").length,
            reducedPrompt: retryPrompt.reduced,
            workspaceId: workspaceId ? String(workspaceId) : null,
            agentId: agent?._id ? String(agent._id) : agent?.id ? String(agent.id) : null,
          });
          const responseData = await Promise.race([
            client.models.generateContent({
              model,
              contents: sanitizeProviderText(retryPrompt.prompt),
              config: {
                systemInstruction: sanitizeProviderText(systemInstruction) || undefined,
                maxOutputTokens: resolveMaxOutputTokens(agent, 600),
              },
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("AI provider timeout")), DEFAULT_TIMEOUT_MS)
            ),
          ]);
          const replyText =
            typeof responseData?.text === "function"
              ? responseData.text()
              : String(responseData?.text || "");
          const reply = replyText.trim() || extractGeminiText(responseData) || "I could not generate a response.";
          const usage = responseData?.usageMetadata || {};
          logGeminiDebug("Gemini generateContent success", {
            model,
            attempt,
            latencyMs: Date.now() - startedAt,
            promptTokens: Number(usage.promptTokenCount || 0),
            outputTokens: Number(usage.candidatesTokenCount || 0),
            totalTokens: Number(usage.totalTokenCount || 0),
            replyChars: reply.length,
          });
          return {
            reply,
            provider: "gemini",
            model,
            raw: {
              latencyMs: Date.now() - startedAt,
              retryPromptReduced: retryPrompt.reduced,
            },
            usage: {
              inputTokens: Number(usage.promptTokenCount || estimateTokens(retryPrompt.prompt)),
              outputTokens: Number(usage.candidatesTokenCount || estimateTokens(reply)),
              totalTokens: Number(usage.totalTokenCount || 0),
            },
          };
        }, { provider: "gemini" });
  return requestPromise
    .then(async (result) => {
      await aiProviderCircuitBreakerService.recordProviderSuccess({
        workspaceId: workspaceId ? String(workspaceId) : "global",
        provider: "gemini",
        model,
      }).catch(() => {});
      return {
        ...result,
        raw: {
          ...(result.raw || {}),
          circuitBreaker: {
            provider: "gemini",
            model,
            status: "closed",
          },
        },
      };
    })
    .catch(async (error) => {
      const normalized = normalizeProviderError(error, { provider: "gemini", model });
      logGeminiDebug("Gemini generateContent failure", {
        model,
        message: normalized?.message || error?.message || "unknown",
        code: normalized?.code || error?.code || null,
        reason: normalized?.reason || null,
        statusCode: normalized?.statusCode || error?.statusCode || error?.response?.status || null,
        retryable: isRetryableRuntimeError(normalized),
        causeMessage: error?.message || null,
        causeName: error?.name || null,
      });
      if (isRetryableRuntimeError(normalized)) {
        await aiProviderCircuitBreakerService.recordProviderFailure({
          workspaceId: workspaceId ? String(workspaceId) : "global",
          provider: "gemini",
          model,
          error: normalized,
        }).catch(() => {});
      }
      throw normalized;
  });
}

async function generateResponse({
  workspaceId = null,
  agent,
  prompt,
  system = "",
  limits = {},
  managedFileSearch = null,
  style = null,
}) {
  const maxInputTokens = Math.max(1, Number(limits.maxInputTokens || 4096) || 4096);
  const effectiveInputTokenLimit = Math.min(
    maxInputTokens,
    Math.max(1200, Number(process.env.AI_PROVIDER_EFFECTIVE_INPUT_TOKEN_LIMIT || 2200))
  );
  const normalizedPrompt = clampPromptToTokenLimit(prompt, effectiveInputTokenLimit);
  const normalizedAgent = {
    ...agent,
    runtimeLimits: {
      maxTokensPerReply: Math.max(
        1,
        Math.min(
          Number(limits.maxTokensPerReply || 1024) || 1024,
          Number(style?.maxOutputTokens || limits.maxTokensPerReply || 1024) || 1024
        )
      ),
    },
  };
  return generateGeminiResponse({
    workspaceId,
    agent: normalizedAgent,
    prompt: normalizedPrompt.prompt,
    systemInstruction: system,
    managedFileSearch,
  })
    .then((result) => ({
      ...result,
      raw: {
        ...(result.raw || {}),
        promptTruncated: normalizedPrompt.truncated,
        promptLimitTokens: effectiveInputTokenLimit,
        replyStyle: style || null,
      },
    }));
}

module.exports = {
  generateResponse,
  estimateTokens,
  DEFAULT_GEMINI_MODEL,
};
