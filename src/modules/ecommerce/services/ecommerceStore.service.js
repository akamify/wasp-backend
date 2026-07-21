const mongoose = require("mongoose");
const crypto = require("crypto");
const { encryptString, decryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");
const repository = require("@modules/ecommerce/repositories/ecommerceStore.repository");
const { validatePublicStoreUrl } = require("@modules/ecommerce/utils/ecommerceUrlSafety");
const woo = require("@modules/ecommerce/services/woocommerceClient.service");

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
    },
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
  return [
    {
      platform: "woocommerce",
      name: "WooCommerce",
      description: "Connect WooCommerce stores and prepare order, product and webhook event sync.",
      connectedStores: wooStores.length,
      statusSummary: platformSummary(wooStores),
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

async function reconnectStore({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
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

async function deleteStore({ workspaceId, storeId }) {
  const store = await getStoreOrThrow({ workspaceId, storeId });
  await cleanupRemoteManagedWebhooks(store);
  store.status = "disconnected";
  store.deletedAt = new Date();
  store.disconnectedAt = store.disconnectedAt || new Date();
  await store.save();
  return { deleted: true };
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
  deleteStore,
  disconnectStore,
  getEvents,
  getHealth,
  getWebhooks,
  listPlatforms,
  listStores,
  rawBodyBuffer,
  receiveWooWebhook,
  reconnectStore,
  setPaused,
  updateStore,
};
