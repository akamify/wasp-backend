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
    throw new HttpError(400, "Could not subscribe WABA to webhook.", {
      message: sanitizeMetaError(err, "WABA webhook subscription failed"),
    });
  }
}

module.exports = { ensureWebhookSubscription };
