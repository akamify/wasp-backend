const { HttpError } = require("@shared/utils/httpError");
const { authHeaders, createMetaClient } = require("@modules/meta/services/metaGraph.service");
const { isRetryableMetaError, normalizeMetaError } = require("@modules/meta/services/metaError.service");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyRegistrationError(err) {
  const normalized = normalizeMetaError(err, "Phone registration failed");
  const code = Number(normalized.code || 0);
  const status = Number(normalized.status || 0);
  const retryable = isRetryableMetaError(err);
  let retryAfterAt = null;
  let recommendedAction = "Review the Meta error and retry only after the blocking condition is resolved.";

  if (code === 133016) {
    retryAfterAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    recommendedAction = "Meta registration limit reached. Wait for the 72-hour window to clear before retrying.";
  } else if ([400, 401, 403].includes(status)) {
    recommendedAction = "Do not retry automatically. Verify the PIN, token type, and Meta permissions.";
  } else if (retryable) {
    recommendedAction = "Retry is allowed for transient Meta errors.";
  }

  return {
    ...normalized,
    retryable,
    retryAfterAt,
    recommendedAction,
  };
}

async function registerPhoneNumber({
  accessToken,
  phoneNumberId,
  pin,
  graphApiVersion,
  maxAttempts = 3,
}) {
  const client = createMetaClient({ graphApiVersion, timeout: 20000 });
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await client.post(
        `/${phoneNumberId}/register`,
        {
          messaging_product: "whatsapp",
          pin,
        },
        {
          headers: authHeaders(accessToken, { "Content-Type": "application/json" }),
        }
      );
      return {
        success: true,
        attemptCount: attempt,
        data: response?.data || null,
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableMetaError(err) || attempt >= maxAttempts) break;
      await sleep(500 * (2 ** (attempt - 1)));
    }
  }

  const details = classifyRegistrationError(lastError);

  throw new HttpError(400, "Phone registration failed.", {
    registration: details,
    retryable: details.retryable,
  });
}

module.exports = { classifyRegistrationError, registerPhoneNumber };
