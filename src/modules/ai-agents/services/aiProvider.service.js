const axios = require("axios");

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 30000);
const DEFAULT_RETRIES = Number(process.env.AI_PROVIDER_RETRIES || 2);

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableProviderError(error) {
  const status = Number(error?.response?.status || 0);
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND"].includes(error?.code);
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
      lastError = error;
      if (attempt >= attempts || !isRetryableProviderError(error)) break;
      await sleep(Math.min(2000, 300 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

function extractOpenAiText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
    }
  }
  return "";
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
    : `Test reply from ${agent.name}: I received "${userMessage}". Add knowledge sources or connect OpenAI/Gemini for real AI replies.`;
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

async function generateOpenAiResponse({ agent, inputMessages, prompt }) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const model = agent.modelName || process.env.OPENAI_AI_AGENT_MODEL || "gpt-4.1-mini";
  const startedAt = Date.now();
  return withRetry(async () => {
    const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model,
      input: inputMessages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      temperature: Number(agent.temperature ?? 0.3),
      max_output_tokens: 600,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: DEFAULT_TIMEOUT_MS,
    },
    );
  const reply = extractOpenAiText(response.data) || "I could not generate a response.";
  const usage = response.data?.usage || {};
  return {
    reply,
    provider: "openai",
    model,
    raw: { id: response.data?.id || null, latencyMs: Date.now() - startedAt },
    usage: {
      inputTokens: Number(usage.input_tokens || estimateTokens(prompt)),
      outputTokens: Number(usage.output_tokens || estimateTokens(reply)),
    },
  };
  }, { provider: "openai" });
}

async function generateGeminiResponse({ agent, prompt }) {
  const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "").trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const model = agent.modelName || process.env.GEMINI_AI_AGENT_MODEL || "gemini-1.5-flash";
  const startedAt = Date.now();
  return withRetry(async () => {
    const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: Number(agent.temperature ?? 0.3),
        maxOutputTokens: 600,
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
  }, { provider: "gemini" });
}

async function generateResponse({ agent, userMessage, prompt, inputMessages, knowledgeChunks }) {
  const provider = String(agent.modelProvider || "manual").toLowerCase();
  if (provider === "openai") {
    return generateOpenAiResponse({ agent, inputMessages, prompt });
  }
  if (provider === "gemini") {
    return generateGeminiResponse({ agent, prompt });
  }
  return generateManualResponse({ agent, userMessage, prompt, knowledgeChunks });
}

module.exports = {
  generateResponse,
  estimateTokens,
};
