const mongoose = require("mongoose");
const crypto = require("crypto");
const { encryptString, decryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");
const { webhookQueue } = require("@infra/queues/index");
const otpService = require("@modules/api-keys/services/apiKeyOtp.service");
const repository = require("@modules/ecommerce/repositories/ecommerceStore.repository");
const { validatePublicStoreUrl } = require("@modules/ecommerce/utils/ecommerceUrlSafety");
const woo = require("@modules/ecommerce/services/woocommerceClient.service");
const shopify = require("@modules/ecommerce/services/shopifyClient.service");

const CUSTOM_WEBHOOK_TOPICS = [
  "customer.created",
  "customer.updated",
  "order.created",
  "order.updated",
  "order.cancelled",
  "order.delivered",
  "order.returned",
  "cart.created",
  "cart.updated",
  "cart.abandoned",
  "cart.recovered",
  "refund.created",
  "product.created",
  "product.updated",
];

const CUSTOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function sanitizeStore(store) {
  const row = typeof store?.toObject === "function" ? store.toObject() : store;
  if (!row) return null;
  return {
    id: String(row._id || row.id || ""),
    workspaceId: String(row.workspaceId || ""),
    platform: row.platform,
    storeName: row.storeName,
    storeUrl: row.storeUrl,
    storeDomain: row.storeDomain,
    status: row.status,
    credentialMetadata: {
      keyPrefix: row.credentials?.keyPrefix || "",
      lastUpdatedAt: row.credentials?.lastUpdatedAt || null,
      tokenStatus: row.provider?.tokenStatus || "",
      grantedScopes: row.provider?.grantedScopes || [],
    },
    provider: row.provider || {},
    connectionHealth: row.connectionHealth || {},
    webhooks: Array.isArray(row.webhooks) ? row.webhooks.map((webhook) => ({
      externalWebhookId: webhook.externalWebhookId || "",
      topic: webhook.topic,
      status: webhook.status,
      managedBy: webhook.managedBy,
      lastSuccessfulDeliveryAt: webhook.lastSuccessfulDeliveryAt || null,
      lastFailureAt: webhook.lastFailureAt || null,
      lastFailureReason: webhook.lastFailureReason || "",
    })) : [],
    lastConnectedAt: row.lastConnectedAt || null,
    lastSuccessfulCheckAt: row.lastSuccessfulCheckAt || null,
    lastWebhookEventAt: row.lastWebhookEventAt || null,
    pausedAt: row.pausedAt || null,
    disconnectedAt: row.disconnectedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function platformSummary(stores) {
  const connected = stores.filter((store) => store.status === "connected").length;
  const paused = stores.filter((store) => store.status === "paused" || store.status === "suspended").length;
  const error = stores.filter((store) => ["connection_error", "degraded", "revoked"].includes(store.status)).length;
  return { connected, paused, error };
}

async function listPlatforms({ workspaceId }) {
  const stores = await repository.listStores({ workspaceId });
  const wooStores = stores.filter((store) => store.platform === "woocommerce");
  const shopifyStores = stores.filter((store) => store.platform === "shopify");
  const customStores = stores.filter((store) => store.platform === "custom");
  const wooSummary = platformSummary(wooStores);
  const shopifySummary = platformSummary(shopifyStores);
  const customSummary = platformSummary(customStores);
  return [
    {
      platform: "woocommerce",
      name: "WooCommerce",
      description: "Connect WooCommerce stores and prepare order, product and webhook event sync.",
      connectedStores: wooSummary.connected,
      statusSummary: wooSummary,
    },
    {
      platform: "shopify",
      name: "Shopify",
      description: "Authorize Shopify stores and manage ecommerce webhook event sync.",
      connectedStores: shopifySummary.connected,
      statusSummary: shopifySummary,
    },
    {
      platform: "custom",
      name: "Custom Store",
      description: "Connect a custom website with signed ecommerce webhooks and workspace-scoped credentials.",
      connectedStores: customSummary.connected,
      statusSummary: customSummary,
    },
  ];
}

async function listStores({ workspaceId, platform }) {
  const stores = await repository.listStores({ workspaceId, platform });
  return stores.map(sanitizeStore);
}

async function getStoreOrThrow({ workspaceId, storeId }) {
  const store = await repository.findStoreById({ workspaceId, storeId });
  if (!store) throw new HttpError(404, "Store not found");
  return store;
}

function encryptedCredentials({ consumerKey, consumerSecret, webhookSecret }) {
  return {
    consumerKeyEnc: encryptString(consumerKey),
    consumerSecretEnc: encryptString(consumerSecret),
    webhookSecretEnc: webhookSecret ? encryptString(webhookSecret) : undefined,
    keyPrefix: String(consumerKey || "").slice(0, 8),
    lastUpdatedAt: new Date(),
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function generateCustomApiKey() {
  return `awc_live_${crypto.randomBytes(32).toString("base64url")}`;
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString("base64url")}`;
}

function customCredentialPayload({ apiKey, webhookSecret }) {
  return {
    apiKey,
    webhookSecret,
    signing: {
      algorithm: "HMAC-SHA256",
      signatureHeader: "X-Webhook-Signature",
      timestampHeader: "X-Webhook-Timestamp",
      signingString: "timestamp.rawBody",
    },
  };
}

function encryptedCustomCredentials({ apiKey, webhookSecret, existing = {} }) {
  const current = typeof existing?.toObject === "function" ? existing.toObject() : existing;
  return {
    ...current,
    apiKeyHash: apiKey ? sha256(apiKey) : current.apiKeyHash || "",
    webhookSecretEnc: webhookSecret ? encryptString(webhookSecret) : current.webhookSecretEnc || "",
    keyPrefix: apiKey ? String(apiKey).slice(0, 12) : current.keyPrefix || "",
    lastUpdatedAt: new Date(),
    secretRotatedAt: webhookSecret ? new Date() : current.secretRotatedAt || null,
    revokedAt: null,
  };
}

function redactPayloadPreview(value, depth = 0) {
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => redactPayloadPreview(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  Object.entries(value).slice(0, 30).forEach(([key, item]) => {
    if (/secret|token|password|authorization|api[-_]?key|card|cvv/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactPayloadPreview(item, depth + 1);
    }
  });
  return out;
}

function parseWebhookTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new HttpError(401, "Missing webhook timestamp");
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 9999999999 ? numeric : numeric * 1000)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new HttpError(401, "Invalid webhook timestamp");
  if (Math.abs(Date.now() - date.getTime()) > CUSTOM_WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    throw new HttpError(401, "Webhook timestamp is outside the allowed window");
  }
  return raw;
}

function verifyCustomSignature({ rawBody, timestamp, signature, secret }) {
  const received = String(signature || "").trim();
  if (!received || !received.startsWith("sha256=")) return false;
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex")}`;
  return (
    Buffer.byteLength(received) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  );
}

function normalizeCustomEventPayload(payload) {
  const topic = String(payload?.event || payload?.topic || "").trim();
  if (!CUSTOM_WEBHOOK_TOPICS.includes(topic)) throw new HttpError(400, "Unsupported custom ecommerce event type");
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  const externalEventId = String(payload?.eventId || payload?.id || data.id || data.orderId || data.customerId || data.productId || "").trim();
  return {
    topic,
    externalEventId,
    data,
    occurredAt: payload?.occurredAt || payload?.timestamp || null,
    isTest: Boolean(payload?.test === true || payload?.isTest === true),
  };
}

function hashState(state) {
  return crypto.createHash("sha256").update(String(state || "")).digest("hex");
}

function oauthCallbackUrl() {
  const base = String(
    process.env.SHOPIFY_APP_URL ||
      process.env.API_URL ||
      process.env.BACKEND_URL ||
      process.env.APP_BASE_URL ||
      ""
  ).replace(/\/+$/, "");
  if (!base) throw new HttpError(503, "Shopify callback base URL is not configured");
  return `${base}/api/ecommerce/shopify/callback`;
}

function frontendRedirectUrl(params) {
  const base = String(process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  const fallback = base || "http://localhost:5173";
  const search = new URLSearchParams(params);
  return `${fallback}/app/ecommerce/shopify?${search.toString()}`;
}

async function startShopifyAuth({ workspaceId, userId, payload }) {
  const purpose = payload.storeId ? "reconnect" : "connect";
  let shopDomain = "";
  if (payload.storeId) {
    const existing = await getStoreOrThrow({ workspaceId, storeId: payload.storeId });
    if (existing.platform !== "shopify") throw new HttpError(400, "Reconnect authorization is only available for Shopify stores");
    shopDomain = shopify.normalizeShopDomain(existing.storeDomain);
  } else if (payload.shopDomain) {
    shopDomain = shopify.normalizeShopDomain(payload.shopDomain);
  }
  if (!shopDomain) {
    const installUrl = shopify.configuredInstallUrl();
    if (!installUrl) {
      return {
        requiresShopContext: true,
        message: "Enter your Shopify store handle to start authorization for this development app.",
      };
    }
  }
  const rawState = crypto.randomBytes(32).toString("base64url");
  await repository.createAuthState({
    stateHash: hashState(rawState),
    workspaceId,
    userId,
    platform: "shopify",
    shopDomain,
    purpose,
    storeId: payload.storeId || null,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  if (!shopDomain) {
    return {
      authorizationUrl: shopify.configuredInstallUrl(),
      state: rawState,
      shopDomain: "",
    };
  }
  return {
    authorizationUrl: shopify.buildAuthorizeUrl({
      shopDomain,
      state: rawState,
      redirectUri: oauthCallbackUrl(),
    }),
    shopDomain,
  };
}

async function continueShopifyInstall({ query, state }) {
  const shopDomain = shopify.normalizeShopDomain(query.shop || "");
  if (!shopify.verifyCallbackHmac(query)) throw new HttpError(401, "Invalid Shopify install signature");
  const authState = await repository.findActiveAuthState({ stateHash: hashState(state || "") });
  if (!authState || authState.platform !== "shopify") throw new HttpError(401, "Invalid or expired Shopify install state");
  if (authState.shopDomain && authState.shopDomain !== shopDomain) {
    throw new HttpError(401, "Shopify install state does not match store");
  }
  return {
    authorizationUrl: shopify.buildAuthorizeUrl({
      shopDomain,
      state,
      redirectUri: oauthCallbackUrl(),
    }),
    shopDomain,
  };
}

function encryptedShopifyCredentials({ accessToken }) {
  return {
    accessTokenEnc: encryptString(accessToken),
    keyPrefix: accessToken ? `${String(accessToken).slice(0, 6)}...` : "",
    lastUpdatedAt: new Date(),
  };
}

async function completeShopifyAuth({ query }) {
  const shopDomain = shopify.normalizeShopDomain(query.shop || "");
  if (!shopify.verifyCallbackHmac(query)) throw new HttpError(401, "Invalid Shopify authorization signature");
  const authState = await repository.consumeAuthState({ stateHash: hashState(query.state || "") });
  if (!authState) throw new HttpError(401, "Invalid or expired Shopify authorization state");
  if (authState.platform !== "shopify" || (authState.shopDomain && authState.shopDomain !== shopDomain)) {
    throw new HttpError(401, "Shopify authorization state does not match store");
  }

  const token = await shopify.exchangeCode({ shopDomain, code: query.code });
  if (!token.accessToken) throw new HttpError(400, "Shopify did not return an access token");
  shopify.assertRequiredScopes(token.grantedScopes);

  const metadata = await shopify.fetchShop({ shopDomain, accessToken: token.accessToken });
  if (metadata.shopDomain !== shopDomain) throw new HttpError(400, "Shopify store identity mismatch");

  const duplicate = await repository.findByPlatformDomain({
    workspaceId: authState.workspaceId,
    platform: "shopify",
    storeDomain: shopDomain,
    excludeId: authState.storeId || undefined,
  });
  if (duplicate && !authState.storeId) throw new HttpError(409, "This Shopify store is already connected");

  const webhooks = await shopify.reconcileWebhooks({ shopDomain, accessToken: token.accessToken });
  const now = new Date();
  const existing = authState.storeId
    ? await getStoreOrThrow({ workspaceId: authState.workspaceId, storeId: authState.storeId })
    : null;
  const target = existing || duplicate;
  if (target) {
    target.storeName = metadata.shopName || target.storeName;
    target.storeUrl = `https://${shopDomain}`;
    target.storeDomain = shopDomain;
    target.externalStoreId = metadata.shopifyShopId;
    target.status = "connected";
    target.credentials = { ...target.credentials, ...encryptedShopifyCredentials(token) };
    target.provider = {
      ...(target.provider || {}),
      shopDomain,
      shopName: metadata.shopName,
      shopifyShopId: metadata.shopifyShopId,
      grantedScopes: token.grantedScopes,
      tokenStatus: "valid",
      tokenExpiresAt: null,
    };
    target.connectionHealth = {
      apiCredentialsValid: true,
      apiAccessValid: true,
      webhooksConfigured: webhooks.length === shopify.WEBHOOK_TOPICS.length,
      lastStatusCode: 200,
      lastError: "",
    };
    target.webhooks = webhooks;
    target.lastConnectedAt = now;
    target.lastSuccessfulCheckAt = now;
    await target.save();
    return sanitizeStore(target);
  }

  const store = await repository.createStore({
    workspaceId: authState.workspaceId,
    platform: "shopify",
    storeName: metadata.shopName || shopDomain,
    storeUrl: `https://${shopDomain}`,
    storeDomain: shopDomain,
    externalStoreId: metadata.shopifyShopId,
    status: "connected",
    credentials: encryptedShopifyCredentials(token),
    provider: {
      shopDomain,
      shopName: metadata.shopName,
      shopifyShopId: metadata.shopifyShopId,
      grantedScopes: token.grantedScopes,
      tokenStatus: "valid",
    },
    connectionHealth: {
      apiCredentialsValid: true,
      apiAccessValid: true,
      webhooksConfigured: webhooks.length === shopify.WEBHOOK_TOPICS.length,
      lastStatusCode: 200,
      lastError: "",
    },
    webhooks,
    lastConnectedAt: now,
    lastSuccessfulCheckAt: now,
    createdBy: authState.userId,
  });
  return sanitizeStore(store);
}

async function connectCustomStore({ workspaceId, userId, payload }) {
  const { storeUrl, storeDomain } = await validatePublicStoreUrl(payload.storeUrl);
  const duplicate = await repository.findDuplicate({ workspaceId, platform: "custom", storeUrl });
  if (duplicate) throw new HttpError(409, "This custom store is already connected");

  const apiKey = generateCustomApiKey();
  const webhookSecret = generateWebhookSecret();
  const store = await repository.createStore({
    workspaceId,
    platform: "custom",
    storeName: payload.storeName,
    storeUrl,
    storeDomain,
    status: "connected",
    credentials: encryptedCustomCredentials({ apiKey, webhookSecret }),
    connectionHealth: {
      apiCredentialsValid: true,
      apiAccessValid: true,
      webhooksConfigured: true,
      lastStatusCode: 200,
      lastError: "",
    },
    webhooks: [{
      topic: "custom.ecommerce.events",
      status: "active",
      managedBy: "ai_wiz_chat",
    }],
    lastConnectedAt: new Date(),
    lastSuccessfulCheckAt: new Date(),
    createdBy: userId,
  });
  return {
    store: sanitizeStore(store),
    credentials: customCredentialPayload({ apiKey, webhookSecret }),
  };
}

async function connectStore({ workspaceId, userId, payload }) {
  const platform = String(payload.platform || "woocommerce").toLowerCase();
  if (platform === "custom") return connectCustomStore({ workspaceId, userId, payload });
  if (platform !== "woocommerce") throw new HttpError(400, "Unsupported ecommerce platform");

  const { storeUrl, storeDomain } = await validatePublicStoreUrl(payload.storeUrl);
  const duplicate = await repository.findDuplicate({ workspaceId, platform, storeUrl });
  if (duplicate) throw new HttpError(409, "This store is already connected");

  await woo.verifyCredentials({ storeUrl, consumerKey: payload.consumerKey, consumerSecret: payload.consumerSecret });

  const storeId = new mongoose.Types.ObjectId();
  let createdStore = null;
  let webhookResult = null;
  try {
    webhookResult = await woo.createManagedWebhooks({
      storeUrl,
      storeId,
      consumerKey: payload.consumerKey,
      consumerSecret: payload.consumerSecret,
    });

    createdStore = await repository.createStore({
      _id: storeId,
      workspaceId,
      platform,
      storeName: payload.storeName,
      storeUrl,
      storeDomain,
      status: "connected",
      credentials: encryptedCredentials({ ...payload, webhookSecret: webhookResult.webhookSecret }),
      connectionHealth: {
        apiCredentialsValid: true,
        apiAccessValid: true,
        webhooksConfigured: true,
        lastStatusCode: 200,
        lastError: "",
      },
      webhooks: webhookResult.webhooks,
      lastConnectedAt: new Date(),
      lastSuccessfulCheckAt: new Date(),
      createdBy: userId,
    });
    return sanitizeStore(createdStore);
  } catch (err) {
    if (createdStore?._id) {
      await createdStore.deleteOne().catch(() => {});
    }
    throw err;
  }
}

async function updateStore({ workspaceId, storeId, payload }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (payload.storeName) store.storeName = payload.storeName;
  if (store.platform === "shopify") {
    await store.save();
    return sanitizeStore(store);
  }
  if (payload.consumerKey || payload.consumerSecret) {
    if (!payload.consumerKey || !payload.consumerSecret) throw new HttpError(400, "Consumer key and secret are both required to update credentials");
    await woo.verifyCredentials({ storeUrl: store.storeUrl, consumerKey: payload.consumerKey, consumerSecret: payload.consumerSecret });
    store.credentials = {
      ...store.credentials,
      ...encryptedCredentials(payload),
      webhookSecretEnc: store.credentials?.webhookSecretEnc || "",
    };
    store.connectionHealth.apiCredentialsValid = true;
    store.connectionHealth.apiAccessValid = true;
    store.connectionHealth.lastError = "";
    store.lastSuccessfulCheckAt = new Date();
  }
  await store.save();
  return sanitizeStore(store);
}

async function reconnectStore({ workspaceId, storeId, userId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (store.platform === "custom") {
    if (store.status === "revoked") throw new HttpError(400, "Revoked custom stores cannot be reconnected. Create a new custom store.");
    store.status = "connected";
    store.connectionHealth.apiCredentialsValid = true;
    store.connectionHealth.apiAccessValid = true;
    store.connectionHealth.webhooksConfigured = Boolean(store.credentials?.apiKeyHash && store.credentials?.webhookSecretEnc);
    store.connectionHealth.lastError = "";
    store.lastSuccessfulCheckAt = new Date();
    await store.save();
    return sanitizeStore(store);
  }
  if (store.platform === "shopify") {
    return {
      requiresAuthorization: true,
      store: sanitizeStore(store),
      authorization: await startShopifyAuth({ workspaceId, userId, payload: { storeId, shop: store.storeDomain } }),
    };
  }
  store.status = "reconnecting";
  await store.save();
  const consumerKey = decryptString(store.credentials?.consumerKeyEnc || "");
  const consumerSecret = decryptString(store.credentials?.consumerSecretEnc || "");
  await woo.verifyCredentials({ storeUrl: store.storeUrl, consumerKey, consumerSecret });
  store.status = "connected";
  store.connectionHealth.apiCredentialsValid = true;
  store.connectionHealth.apiAccessValid = true;
  store.connectionHealth.lastError = "";
  store.lastSuccessfulCheckAt = new Date();
  await store.save();
  return sanitizeStore(store);
}

async function setPaused({ workspaceId, storeId, paused }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  store.status = paused ? (store.platform === "custom" ? "suspended" : "paused") : "connected";
  store.pausedAt = paused ? new Date() : null;
  await store.save();
  return sanitizeStore(store);
}

async function cleanupRemoteManagedWebhooks(store) {
  try {
    if (store.platform === "custom") return;
    if (store.platform === "shopify") {
      const accessToken = decryptString(store.credentials?.accessTokenEnc || "");
      if (!accessToken) return;
      await shopify.cleanupManagedWebhooks({
        shopDomain: store.storeDomain,
        accessToken,
        webhooks: store.webhooks || [],
      });
      return;
    }
    const consumerKey = decryptString(store.credentials?.consumerKeyEnc || "");
    const consumerSecret = decryptString(store.credentials?.consumerSecretEnc || "");
    await woo.cleanupManagedWebhooks({
      storeUrl: store.storeUrl,
      consumerKey,
      consumerSecret,
      webhooks: store.webhooks || [],
    });
  } catch {
    // Remote cleanup is best-effort; local processing must still stop.
  }
}

async function disconnectStore({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  await cleanupRemoteManagedWebhooks(store);
  store.status = "disconnected";
  store.disconnectedAt = new Date();
  store.webhooks = store.webhooks.map((webhook) => {
    const plain = typeof webhook?.toObject === "function" ? webhook.toObject() : webhook;
    return { ...plain, status: "disabled" };
  });
  await store.save();
  return sanitizeStore(store);
}

function rawBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  return Buffer.from(JSON.stringify(req.body || {}));
}

function verifyWooSignature({ rawBody, signature, secret }) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const received = String(signature || "").trim();
  return (
    Buffer.byteLength(received) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  );
}

async function receiveWooWebhook({ storeId, headers, rawBody, payload }) {
  const store = await repository.findStoreForWebhook(storeId);
  if (!store || store.platform !== "woocommerce") throw new HttpError(404, "Store not found");
  if (store.status === "paused" || store.status === "disconnected") return { accepted: true, skipped: true };

  const secret = decryptString(store.credentials?.webhookSecretEnc || "");
  const signature = headers["x-wc-webhook-signature"];
  if (!verifyWooSignature({ rawBody, signature, secret })) throw new HttpError(401, "Invalid webhook signature");

  const topic = String(headers["x-wc-webhook-topic"] || payload?.topic || "unknown").trim();
  const externalEventId = String(headers["x-wc-webhook-delivery-id"] || payload?.id || "").trim();
  const idempotencyKey = `${store._id}:${topic}:${externalEventId || crypto.createHash("sha256").update(rawBody).digest("hex")}`;

  try {
    await repository.createEvent({
      workspaceId: store.workspaceId,
      storeId: store._id,
      platform: "woocommerce",
      topic,
      externalEventId,
      idempotencyKey,
      status: "received",
      summary: `${topic} received`,
      payloadPreview: {
        id: payload?.id,
        status: payload?.status,
        date_created: payload?.date_created,
      },
    });
  } catch (err) {
    if (Number(err?.code) !== 11000) throw err;
  }

  store.lastWebhookEventAt = new Date();
  await store.save();
  return { accepted: true };
}

async function receiveShopifyWebhook({ headers, rawBody, payload }) {
  const signature = headers["x-shopify-hmac-sha256"];
  if (!shopify.verifyWebhookHmac({ rawBody, signature })) throw new HttpError(401, "Invalid webhook signature");

  const shopDomain = shopify.normalizeShopDomain(headers["x-shopify-shop-domain"] || "");
  const store = await repository.findStoreForShopifyWebhook(shopDomain);
  if (!store || store.platform !== "shopify") throw new HttpError(404, "Store not found");
  if (store.status === "paused" || store.status === "disconnected" || store.status === "uninstalled") {
    return { accepted: true, skipped: true };
  }

  const topic = String(headers["x-shopify-topic"] || "unknown").trim();
  const externalEventId = String(headers["x-shopify-webhook-id"] || payload?.id || "").trim();
  const idempotencyKey = `${store._id}:${topic}:${externalEventId || crypto.createHash("sha256").update(rawBody).digest("hex")}`;

  try {
    await repository.createEvent({
      workspaceId: store.workspaceId,
      storeId: store._id,
      platform: "shopify",
      topic,
      externalEventId,
      idempotencyKey,
      status: "received",
      summary: `${topic} received`,
      payloadPreview: {
        id: payload?.id,
        email: payload?.email,
        name: payload?.name,
        order_number: payload?.order_number,
        financial_status: payload?.financial_status,
      },
    });
  } catch (err) {
    if (Number(err?.code) !== 11000) throw err;
  }

  store.lastWebhookEventAt = new Date();
  const webhook = (store.webhooks || []).find((item) => item.topic === topic);
  if (webhook) webhook.lastSuccessfulDeliveryAt = new Date();
  if (topic === "app/uninstalled") {
    store.status = "uninstalled";
    store.disconnectedAt = new Date();
    store.credentials.accessTokenEnc = "";
    store.provider = store.provider || {};
    store.provider.tokenStatus = "revoked";
  }
  await store.save();
  return { accepted: true };
}

async function enqueueCustomEvent(event) {
  try {
    const queue = webhookQueue.getWebhookQueue();
    await queue.add("ecommerce.custom.process", {
      eventId: String(event._id || event.id || ""),
    });
    return true;
  } catch (err) {
    await repository.updateEventStatus({
      eventId: event._id,
      patch: {
        status: "failed",
        error: "Queue unavailable",
      },
    });
    return false;
  }
}

function extractCustomApiKey(headers) {
  const authHeader = String(headers.authorization || headers.Authorization || "").trim();
  if (/^Bearer\s+/i.test(authHeader)) return authHeader.replace(/^Bearer\s+/i, "").trim();
  return String(headers["x-api-key"] || headers["X-API-Key"] || "").trim();
}

async function receiveCustomWebhook({ storeId, headers, rawBody, payload }) {
  const apiKey = extractCustomApiKey(headers || {});
  if (!apiKey) throw new HttpError(401, "Missing ecommerce webhook API key");

  const store = await repository.findCustomStoreByApiKeyHash(sha256(apiKey));
  if (!store || String(store._id) !== String(storeId)) throw new HttpError(401, "Invalid ecommerce webhook API key");
  if (["paused", "suspended"].includes(store.status)) return { accepted: true, skipped: true };
  if (["disconnected", "revoked", "uninstalled"].includes(store.status)) throw new HttpError(403, "Custom store integration is not active");

  const timestamp = parseWebhookTimestamp(headers["x-webhook-timestamp"] || headers["X-Webhook-Timestamp"]);
  const secret = decryptString(store.credentials?.webhookSecretEnc || "");
  if (!secret || !verifyCustomSignature({ rawBody, timestamp, signature: headers["x-webhook-signature"] || headers["X-Webhook-Signature"], secret })) {
    throw new HttpError(401, "Invalid webhook signature");
  }

  const eventPayload = normalizeCustomEventPayload(payload);
  const signatureHash = sha256(headers["x-webhook-signature"] || "");
  const idempotencyKey = `${store._id}:${eventPayload.topic}:${eventPayload.externalEventId || `${timestamp}:${signatureHash}`}`;
  let event = null;
  try {
    event = await repository.createEvent({
      workspaceId: store.workspaceId,
      storeId: store._id,
      platform: "custom",
      topic: eventPayload.topic,
      externalEventId: eventPayload.externalEventId,
      idempotencyKey,
      status: "queued",
      queuedAt: new Date(),
      isTest: eventPayload.isTest,
      summary: `${eventPayload.topic} queued`,
      payloadPreview: redactPayloadPreview(eventPayload.data),
    });
  } catch (err) {
    if (Number(err?.code) !== 11000) throw err;
    return { accepted: true, duplicate: true, status: "duplicate" };
  }

  store.lastWebhookEventAt = new Date();
  const webhook = (store.webhooks || []).find((item) => item.topic === "custom.ecommerce.events");
  if (webhook) webhook.lastSuccessfulDeliveryAt = new Date();
  await store.save();

  const queued = await enqueueCustomEvent(event);
  return { accepted: true, eventId: String(event._id), status: queued ? "queued" : "failed" };
}

async function processCustomEventJob(job) {
  const eventId = job?.data?.eventId;
  const event = await repository.findEventById(eventId);
  if (!event || event.platform !== "custom") return { skipped: true };
  if (event.status === "processed") return { skipped: true, duplicate: true };

  event.status = "processing";
  event.retryCount = Number(job?.attemptsMade || 0);
  await event.save();

  try {
    // V1 persists and verifies the ecommerce event contract. Downstream CRM,
    // audience, and automation fan-out can subscribe here without changing the
    // public webhook contract.
    event.status = "processed";
    event.processedAt = new Date();
    event.error = "";
    await event.save();
    return { processed: true, eventId: String(event._id), test: Boolean(event.isTest) };
  } catch (err) {
    event.status = Number(job?.attemptsMade || 0) + 1 >= Number(job?.opts?.attempts || 1) ? "dead_letter" : "retrying";
    event.error = err?.message || "Custom ecommerce event processing failed";
    await event.save();
    throw err;
  }
}

async function sendCustomSecretOtp({ workspaceId, storeId, userId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (store.platform !== "custom") throw new HttpError(400, "Secret rotation is only available for custom stores");
  return otpService.sendSecurityOtp({
    userId,
    purpose: "ecommerce_custom_secret_rotate",
    keyId: storeId,
    title: "Rotate custom store webhook secret",
    subtitle: "Use this OTP to rotate your custom ecommerce webhook signing secret.",
  });
}

async function rotateCustomSecret({ workspaceId, storeId, userId, otp }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (store.platform !== "custom") throw new HttpError(400, "Secret rotation is only available for custom stores");
  await otpService.verifySecurityOtp({
    userId,
    otp,
    purpose: "ecommerce_custom_secret_rotate",
    keyId: storeId,
  });
  const webhookSecret = generateWebhookSecret();
  store.credentials = encryptedCustomCredentials({
    webhookSecret,
    existing: store.credentials || {},
  });
  store.status = store.status === "revoked" ? "revoked" : "connected";
  await store.save();
  return {
    store: sanitizeStore(store),
    credentials: {
      webhookSecret,
      signing: customCredentialPayload({ apiKey: "", webhookSecret }).signing,
    },
  };
}

async function revokeCustomStore({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (store.platform !== "custom") throw new HttpError(400, "Revoke is only available for custom stores");
  store.status = "revoked";
  store.credentials.apiKeyHash = "";
  store.credentials.webhookSecretEnc = "";
  store.credentials.revokedAt = new Date();
  store.disconnectedAt = new Date();
  await store.save();
  return sanitizeStore(store);
}

async function sendCustomTestEvent({ workspaceId, storeId, payload }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  if (store.platform !== "custom") throw new HttpError(400, "Test event is only available for custom stores");
  if (["disconnected", "revoked", "uninstalled"].includes(store.status)) throw new HttpError(403, "Custom store integration is not active");
  const topic = String(payload?.topic || "order.created").trim();
  if (!CUSTOM_WEBHOOK_TOPICS.includes(topic)) throw new HttpError(400, "Unsupported custom ecommerce event type");
  const event = await repository.createEvent({
    workspaceId: store.workspaceId,
    storeId: store._id,
    platform: "custom",
    topic,
    externalEventId: `test_${Date.now()}`,
    idempotencyKey: `${store._id}:${topic}:test:${crypto.randomUUID()}`,
    status: "queued",
    queuedAt: new Date(),
    isTest: true,
    summary: `${topic} test queued`,
    payloadPreview: redactPayloadPreview(payload?.payload || { source: "dashboard_test" }),
  });
  const queued = await enqueueCustomEvent(event);
  return { accepted: true, eventId: String(event._id), status: queued ? "queued" : "failed" };
}

async function deleteStore({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  const snapshot = sanitizeStore(store);
  await cleanupRemoteManagedWebhooks(store);
  store.status = "disconnected";
  store.deletedAt = new Date();
  store.disconnectedAt = store.disconnectedAt || new Date();
  await store.save();
  return { deleted: true, store: snapshot };
}

async function getHealth({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  return {
    store: sanitizeStore(store),
    health: store.connectionHealth || {},
  };
}

async function getWebhooks({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  return { webhooks: sanitizeStore(store).webhooks };
}

async function getEvents({ workspaceId, storeId, limit }) {
  await getStoreOrThrow({ workspaceId, storeId });
  const events = await repository.listEvents({ workspaceId, storeId, limit });
  return {
    events: events.map((event) => ({
      id: String(event._id || ""),
      topic: event.topic,
      status: event.status,
      summary: event.summary,
      receivedAt: event.receivedAt,
      processedAt: event.processedAt,
      queuedAt: event.queuedAt,
      isTest: Boolean(event.isTest),
      error: event.error,
      payloadPreview: event.payloadPreview || null,
      createdAt: event.createdAt,
    })),
  };
}

module.exports = {
  connectStore,
  completeShopifyAuth,
  continueShopifyInstall,
  deleteStore,
  disconnectStore,
  getEvents,
  getHealth,
  getWebhooks,
  listPlatforms,
  listStores,
  processCustomEventJob,
  rawBodyBuffer,
  receiveCustomWebhook,
  receiveShopifyWebhook,
  receiveWooWebhook,
  reconnectStore,
  revokeCustomStore,
  rotateCustomSecret,
  sendCustomSecretOtp,
  sendCustomTestEvent,
  setPaused,
  startShopifyAuth,
  updateStore,
};
