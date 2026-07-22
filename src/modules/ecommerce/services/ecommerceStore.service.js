const mongoose = require("mongoose");
const crypto = require("crypto");
const { encryptString, decryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");
const repository = require("@modules/ecommerce/repositories/ecommerceStore.repository");
const { validatePublicStoreUrl } = require("@modules/ecommerce/utils/ecommerceUrlSafety");
const woo = require("@modules/ecommerce/services/woocommerceClient.service");
const shopify = require("@modules/ecommerce/services/shopifyClient.service");

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
  const paused = stores.filter((store) => store.status === "paused").length;
  const error = stores.filter((store) => ["connection_error", "degraded"].includes(store.status)).length;
  return { connected, paused, error };
}

async function listPlatforms({ workspaceId }) {
  const stores = await repository.listStores({ workspaceId });
  const wooStores = stores.filter((store) => store.platform === "woocommerce");
  const shopifyStores = stores.filter((store) => store.platform === "shopify");
  return [
    {
      platform: "woocommerce",
      name: "WooCommerce",
      description: "Connect WooCommerce stores and prepare order, product and webhook event sync.",
      connectedStores: wooStores.length,
      statusSummary: platformSummary(wooStores),
    },
    {
      platform: "shopify",
      name: "Shopify",
      description: "Authorize Shopify stores and manage ecommerce webhook event sync.",
      connectedStores: shopifyStores.length,
      statusSummary: platformSummary(shopifyStores),
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
  const shopDomain = shopify.normalizeShopDomain(payload.shop || payload.shopDomain || "");
  const purpose = payload.storeId ? "reconnect" : "connect";
  if (payload.storeId) {
    const existing = await getStoreOrThrow({ workspaceId, storeId: payload.storeId });
    if (existing.platform !== "shopify") throw new HttpError(400, "Reconnect authorization is only available for Shopify stores");
    if (existing.storeDomain !== shopDomain) throw new HttpError(400, "Shopify reconnect store domain does not match the connected store");
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
  return {
    authorizationUrl: shopify.buildAuthorizeUrl({
      shopDomain,
      state: rawState,
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
  if (authState.platform !== "shopify" || authState.shopDomain !== shopDomain) {
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

async function connectStore({ workspaceId, userId, payload }) {
  const platform = String(payload.platform || "woocommerce").toLowerCase();
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
  store.status = paused ? "paused" : "connected";
  store.pausedAt = paused ? new Date() : null;
  await store.save();
  return sanitizeStore(store);
}

async function cleanupRemoteManagedWebhooks(store) {
  try {
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
      error: event.error,
      createdAt: event.createdAt,
    })),
  };
}

module.exports = {
  connectStore,
  completeShopifyAuth,
  deleteStore,
  disconnectStore,
  getEvents,
  getHealth,
  getWebhooks,
  listPlatforms,
  listStores,
  rawBodyBuffer,
  receiveShopifyWebhook,
  receiveWooWebhook,
  reconnectStore,
  setPaused,
  startShopifyAuth,
  updateStore,
};
