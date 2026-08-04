const { HttpError } = require("@shared/utils/httpError");
const { sanitizeMetaError } = require("@modules/meta/services/metaError.service");

async function ensureWebhookSubscription({
  client,
  accessToken,
  wabaId,
}) {
  try {
    const response = await client.post(`/${wabaId}/subscribed_apps`, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response?.data?.success) {
      throw new HttpError(400, "Could not subscribe WABA to webhook.");
    }
    return true;
  } catch (err) {
    const statusCode = Number(err?.response?.status || err?.statusCode || 400);
    throw new HttpError(statusCode >= 400 && statusCode < 600 ? statusCode : 400, "Could not subscribe WABA to webhook.", {
      step: "subscribe_waba_webhook",
      endpoint: `/${wabaId}/subscribed_apps`,
      message: sanitizeMetaError(err, "WABA webhook subscription failed"),
      status: err?.response?.status || null,
      code: err?.response?.data?.error?.code || null,
      subcode: err?.response?.data?.error?.error_subcode || null,
      fbtraceId: err?.response?.data?.error?.fbtrace_id || null,
    });
  }
}

module.exports = { ensureWebhookSubscription };
