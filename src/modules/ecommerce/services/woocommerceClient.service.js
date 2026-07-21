const axios = require("axios");
const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const WEBHOOK_TOPICS = ["order.created", "order.updated", "product.updated"];

function authConfig(consumerKey, consumerSecret) {
  return {
    auth: {
      username: consumerKey,
      password: consumerSecret,
    },
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_RESPONSE_BYTES,
    validateStatus: () => true,
  };
}

function endpoint(storeUrl, path) {
  return `${String(storeUrl || "").replace(/\/+$/, "")}/wp-json/wc/v3${path}`;
}

async function verifyCredentials({ storeUrl, consumerKey, consumerSecret }) {
  const res = await axios.get(endpoint(storeUrl, "/system_status"), authConfig(consumerKey, consumerSecret));
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(400, "Invalid WooCommerce credentials");
  }
  if (res.status === 404) {
    throw new HttpError(400, "WooCommerce REST API is not available for this store");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(400, "Unable to validate WooCommerce API access");
  }
  return { status: res.status };
}

function publicWebhookBaseUrl() {
  return String(
    process.env.ECOMMERCE_WEBHOOK_BASE_URL ||
      process.env.API_URL ||
      process.env.BACKEND_URL ||
      process.env.APP_BASE_URL ||
      ""
  ).replace(/\/+$/, "");
}

function buildWebhookSecret() {
  return `wcwh_${crypto.randomBytes(32).toString("hex")}`;
}

async function createManagedWebhooks({ storeUrl, storeId, consumerKey, consumerSecret }) {
  const baseUrl = publicWebhookBaseUrl();
  if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
    throw new HttpError(400, "Public ecommerce webhook URL is not configured");
  }

  const created = [];
  const secret = buildWebhookSecret();
  const deliveryUrl = `${baseUrl}/api/ecommerce/webhooks/woocommerce/${encodeURIComponent(String(storeId))}`;

  try {
    for (const topic of WEBHOOK_TOPICS) {
      const res = await axios.post(
        endpoint(storeUrl, "/webhooks"),
        {
          name: `AI Wiz Chat ${topic}`,
          topic,
          delivery_url: deliveryUrl,
          secret,
          status: "active",
        },
        authConfig(consumerKey, consumerSecret)
      );
      if (res.status === 401 || res.status === 403) throw new HttpError(400, "API credentials do not have webhook permissions");
      if (res.status < 200 || res.status >= 300) throw new HttpError(400, "Unable to configure required webhooks");
      created.push({
        externalWebhookId: String(res.data?.id || ""),
        topic,
        status: "active",
        managedBy: "ai_wiz_chat",
      });
    }
    return { webhooks: created, webhookSecret: secret };
  } catch (err) {
    await cleanupManagedWebhooks({ storeUrl, consumerKey, consumerSecret, webhooks: created });
    throw err;
  }
}

async function cleanupManagedWebhooks({ storeUrl, consumerKey, consumerSecret, webhooks = [] }) {
  await Promise.allSettled(
    webhooks
      .filter((webhook) => webhook.externalWebhookId)
      .map((webhook) =>
        axios.delete(endpoint(storeUrl, `/webhooks/${encodeURIComponent(webhook.externalWebhookId)}`), authConfig(consumerKey, consumerSecret))
      )
  );
}

module.exports = {
  WEBHOOK_TOPICS,
  verifyCredentials,
  createManagedWebhooks,
  cleanupManagedWebhooks,
};
