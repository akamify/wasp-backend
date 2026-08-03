const BLOCKED_DEFAULT_PATTERNS = [
  /password|otp|one[-\s]?time password/i,
  /private key|secret key|api key/i,
];

const PROMPT_INJECTION_PATTERNS = [
  /ignore (all )?(previous|above|prior) (instructions|rules|messages)/i,
  /system prompt|developer message|hidden instruction|internal instruction/i,
  /(reveal|show|print|dump).{0,40}(system prompt|developer message|hidden instruction|internal instruction|rules|policy|secret)/i,
  /jailbreak|dan mode|do anything now/i,
  /act as (system|developer|admin|root)/i,
  /override (your )?(rules|instructions|policy)/i,
];

function textMatchesAny(text, items) {
  const normalized = String(text || "").toLowerCase();
  return (items || []).some((item) => item && normalized.includes(String(item).toLowerCase()));
}

function estimateConfidence({ reply, agent, providerResult }) {
  const text = String(reply || "").trim();
  if (!text) return 0.1;
  let confidence = providerResult.provider === "manual" ? 0.72 : 0.86;
  if (/not sure|not fully sure|don't know|cannot confirm|unable to confirm/i.test(text)) confidence -= 0.25;
  if (!Array.isArray(agent.knowledgeSources) || agent.knowledgeSources.length === 0) confidence -= 0.15;
  return Math.max(0.1, Math.min(0.98, Number(confidence.toFixed(2))));
}

function detectPromptInjection(text) {
  const value = String(text || "");
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

function preCheckUserMessage({ agent, userMessage, conversation }) {
  const guardrails = agent.guardrails || {};
  const blockedTopics = guardrails.blockedTopics || [];
  const maxMessages = Number(guardrails.maxMessagesPerSession || 50);
  const existingMessageCount = Array.isArray(conversation?.messages) ? conversation.messages.length : 0;

  if (detectPromptInjection(userMessage)) {
    return {
      passed: false,
      action: "blocked",
      confidence: 0.99,
      reply: guardrails.fallbackMessage || "I cannot follow requests that try to override my safety or business instructions.",
      reason: "prompt_injection",
    };
  }

  if (BLOCKED_DEFAULT_PATTERNS.some((pattern) => pattern.test(userMessage))) {
    return {
      passed: false,
      action: "handover",
      confidence: 0.9,
      reply: guardrails.fallbackMessage || "I cannot help with that request. Let me connect you with our team.",
      reason: "sensitive_request",
    };
  }

  if (textMatchesAny(userMessage, blockedTopics)) {
    return {
      passed: false,
      action: "handover",
      confidence: 0.9,
      reply: guardrails.fallbackMessage || "Let me connect you with our team for that topic.",
      reason: "blocked_topic",
    };
  }

  if (existingMessageCount >= maxMessages * 2) {
    return {
      passed: false,
      action: "handover",
      confidence: 0.9,
      reply: guardrails.fallbackMessage || "Let me connect you with our team for further help.",
      reason: "max_messages_exceeded",
    };
  }

  return { passed: true };
}

function applyGuardrails({ agent, userMessage, reply, providerResult, conversation }) {
  const guardrails = agent.guardrails || {};
  const blockedTopics = guardrails.blockedTopics || [];
  const maxMessages = Number(guardrails.maxMessagesPerSession || 50);
  const existingMessageCount = Array.isArray(conversation?.messages) ? conversation.messages.length : 0;
  const confidence = estimateConfidence({ reply, agent, providerResult });

  const blockedByPattern = BLOCKED_DEFAULT_PATTERNS.some((pattern) => pattern.test(userMessage));
  const blockedByTopic = textMatchesAny(userMessage, blockedTopics);
  const maxMessagesExceeded = existingMessageCount >= maxMessages * 2;
  const threshold = Math.min(0.95, Math.max(0.1, Number(guardrails.confidenceThreshold || 0.55)));
  const lowConfidence = confidence < threshold;

  if (blockedByPattern || blockedByTopic) {
    return {
      passed: false,
      action: "handover",
      confidence,
      reply: guardrails.fallbackMessage || "I cannot help with that request. Let me connect you with our team.",
      reason: blockedByPattern ? "sensitive_request" : "blocked_topic",
    };
  }

  if (maxMessagesExceeded) {
    return {
      passed: false,
      action: "handover",
      confidence,
      reply: guardrails.fallbackMessage || "Let me connect you with our team for further help.",
      reason: "max_messages_exceeded",
    };
  }

  if (lowConfidence && guardrails.handoverOnLowConfidence !== false) {
    return {
      passed: false,
      action: "handover",
      confidence,
      reply: guardrails.fallbackMessage || "I am not fully sure. Let me connect you with our team.",
      reason: "low_confidence",
    };
  }

  return {
    passed: true,
    action: "reply",
    confidence,
    reply,
    reason: null,
  };
}

module.exports = { applyGuardrails, preCheckUserMessage, detectPromptInjection };
