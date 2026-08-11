const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const aiProviderConfigService = require("@modules/ai-agents/services/aiProviderConfig.service");
const aiProviderCircuitBreakerService = require("@modules/ai-agents/services/aiProviderCircuitBreaker.service");
const {
  normalizeProviderError,
  isRetryableRuntimeError,
} = require("@modules/ai-agents/services/aiRuntimeError.service");

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30000);
const DEFAULT_RETRIES = Number(process.env.AI_PROVIDER_RETRIES || 2);
const DEFAULT_GEMINI_MODEL = aiProviderConfigService.DEFAULT_GEMINI_MODEL;

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function generateGeminiResponse({ workspaceId = null, agent, prompt }) {
  const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "").trim();
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
  return withRetry(async () => {
    const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: Math.max(1, Number(agent?.runtimeLimits?.maxTokensPerReply || 600)),
      },
    },
      { timeout: DEFAULT_TIMEOUT_MS },
    );
  const reply = extractGeminiText(response.data) || "I could not generate a response.";
  const usage = response.data?.usageMetadata || {};
  return {
    reply,
    provider: "gemini",
    model,
    raw: { latencyMs: Date.now() - startedAt },
    usage: {
      inputTokens: Number(usage.promptTokenCount || estimateTokens(prompt)),
      outputTokens: Number(usage.candidatesTokenCount || estimateTokens(reply)),
    },
  };
  }, { provider: "gemini" })
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

async function generateResponse({ workspaceId = null, agent, prompt, limits = {} }) {
  const inputTokens = estimateTokens(prompt);
  const maxInputTokens = Math.max(1, Number(limits.maxInputTokens || 4096) || 4096);
  if (inputTokens > maxInputTokens) {
    throw new HttpError(400, `Prompt exceeds workspace AI input token limit of ${maxInputTokens}.`);
  }
  const normalizedAgent = {
    ...agent,
    runtimeLimits: {
      maxTokensPerReply: Math.max(1, Number(limits.maxTokensPerReply || 1024) || 1024),
    },
  };
  return generateGeminiResponse({ workspaceId, agent: normalizedAgent, prompt });
}

module.exports = {
  generateResponse,
  estimateTokens,
  DEFAULT_GEMINI_MODEL,
};
