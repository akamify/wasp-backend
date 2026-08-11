const { HttpError } = require("@shared/utils/httpError");

class AiRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || "AiRuntimeError";
    this.code = options.code || "AI_RUNTIME_ERROR";
    this.retryable = Boolean(options.retryable);
    this.statusCode = options.statusCode ?? null;
    this.category = options.category || "runtime";
    this.reason = options.reason || null;
    this.details = options.details || null;
    this.cause = options.cause || null;
  }
}

class AiRuntimeRetryableError extends AiRuntimeError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: "AiRuntimeRetryableError",
      retryable: true,
    });
  }
}

class AiRuntimeNonRetryableError extends AiRuntimeError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: "AiRuntimeNonRetryableError",
      retryable: false,
    });
  }
}

function isRetryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status || 0));
}

function isRetryableCode(code) {
  return ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN"].includes(String(code || ""));
}

function isRetryableMessage(message) {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("connection is closed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("econnreset") ||
    normalized.includes("upstream connect error") ||
    normalized.includes("tls") ||
    normalized.includes("network")
  );
}

function isRetryableRuntimeError(error) {
  if (!error) return false;
  if (typeof error.retryable === "boolean") return error.retryable;
  if (isRetryableStatus(error?.statusCode || error?.status || error?.response?.status)) return true;
  return isRetryableCode(error?.code) || isRetryableMessage(error?.message);
}

function isNonRetryableRuntimeError(error) {
  if (!error) return false;
  if (typeof error.retryable === "boolean") return !error.retryable;
  const status = Number(error?.statusCode || error?.status || error?.response?.status || 0);
  if (status && !isRetryableStatus(status)) return true;
  return false;
}

function normalizeProviderError(error, { provider = "gemini", model = null } = {}) {
  if (error instanceof AiRuntimeError) return error;
  if (error instanceof HttpError) {
    const status = Number(error.statusCode || 500);
    const base = {
      code: status >= 500 ? "AI_PROVIDER_INTERNAL_ERROR" : "AI_PROVIDER_REQUEST_INVALID",
      statusCode: status,
      category: "provider",
      reason: status >= 500 ? "provider_unavailable" : "provider_invalid_request",
      details: { provider, model },
      cause: error,
    };
    if (isRetryableStatus(status)) {
      return new AiRuntimeRetryableError(error.message || "AI provider temporarily unavailable", base);
    }
    return new AiRuntimeNonRetryableError(error.message || "AI provider request failed", base);
  }

  const status = Number(error?.response?.status || 0);
  const timeoutLike =
    isRetryableCode(error?.code) &&
    ["ETIMEDOUT", "ECONNABORTED"].includes(String(error?.code || ""));
  if (timeoutLike || String(error?.message || "").toLowerCase().includes("timeout")) {
    return new AiRuntimeRetryableError("AI provider timeout", {
      code: "AI_PROVIDER_TIMEOUT",
      statusCode: status || 504,
      category: "provider",
      reason: "provider_timeout",
      details: { provider, model },
      cause: error,
    });
  }
  if (isRetryableMessage(error?.message)) {
    return new AiRuntimeRetryableError(error?.message || "AI provider connection closed", {
      code: "AI_PROVIDER_CONNECTION_CLOSED",
      statusCode: status || 502,
      category: "provider",
      reason: "provider_connection_closed",
      details: { provider, model },
      cause: error,
    });
  }
  if (isRetryableStatus(status) || isRetryableCode(error?.code)) {
    return new AiRuntimeRetryableError("AI provider temporarily unavailable", {
      code: "AI_PROVIDER_RETRYABLE",
      statusCode: status || null,
      category: "provider",
      reason: status === 429 ? "provider_rate_limited" : "provider_unavailable",
      details: { provider, model },
      cause: error,
    });
  }
  return new AiRuntimeNonRetryableError(error?.message || "AI provider request failed", {
    code: "AI_PROVIDER_NON_RETRYABLE",
    statusCode: status || null,
    category: "provider",
    reason: "provider_non_retryable",
    details: { provider, model },
    cause: error,
  });
}

module.exports = {
  AiRuntimeError,
  AiRuntimeRetryableError,
  AiRuntimeNonRetryableError,
  isRetryableRuntimeError,
  isNonRetryableRuntimeError,
  normalizeProviderError,
};
