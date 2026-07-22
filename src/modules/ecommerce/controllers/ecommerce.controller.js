const service = require("@modules/ecommerce/services/ecommerceStore.service");
const { writeAuditLog } = require("@shared/services/auditLog.service");

function workspaceId(req) {
  return String(req.workspace?.id || "");
}

function userId(req) {
  return String(req.user?.id || "");
}

const SHOPIFY_STATE_COOKIE = "aiwiz_shopify_state";

function frontendShopifyRedirect(params) {
  const base = String(process.env.FRONTEND_BASE_URL || process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  return `${base}/app/ecommerce/shopify?${new URLSearchParams(params).toString()}`;
}

function readCookie(req, name) {
  const raw = String(req.headers?.cookie || "");
  const parts = raw.split(";").map((part) => part.trim());
  const found = parts.find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function setShopifyStateCookie(req, res, state) {
  res.cookie(SHOPIFY_STATE_COOKIE, state, {
    httpOnly: true,
    secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
}

function clearShopifyStateCookie(res) {
  res.clearCookie(SHOPIFY_STATE_COOKIE, { path: "/" });
}

async function audit(req, action, store, metadata = {}) {
  await writeAuditLog(req, {
    action,
    resourceType: "ecommerce_store",
    resourceId: String(store?.id || store?._id || req.params?.storeId || ""),
    metadata: {
      workspaceId: workspaceId(req),
      platform: store?.platform || metadata.platform || "woocommerce",
      storeDomain: store?.storeDomain || metadata.storeDomain || "",
      ...metadata,
    },
  });
}

async function listPlatforms(req, res) {
  const platforms = await service.listPlatforms({ workspaceId: workspaceId(req) });
  return res.json({ success: true, platforms });
}

async function listStores(req, res) {
  const stores = await service.listStores({ workspaceId: workspaceId(req), platform: req.query.platform });
  return res.json({ success: true, stores });
}

async function createStore(req, res) {
  const store = await service.connectStore({ workspaceId: workspaceId(req), userId: userId(req), payload: req.body });
  await audit(req, "store_connected", store);
  await audit(req, "webhook_created", store, { topics: (store.webhooks || []).map((webhook) => webhook.topic) });
  return res.status(201).json({ success: true, store });
}

async function updateStore(req, res) {
  const store = await service.updateStore({ workspaceId: workspaceId(req), storeId: req.params.storeId, payload: req.body });
  await audit(req, req.body.consumerKey || req.body.consumerSecret ? "credentials_updated" : "store_metadata_updated", store);
  return res.json({ success: true, store });
}

async function reconnectStore(req, res) {
  const result = await service.reconnectStore({ workspaceId: workspaceId(req), storeId: req.params.storeId, userId: userId(req) });
  if (result?.requiresAuthorization) {
    await audit(req, "shopify_connection_started", result.store, { platform: "shopify", purpose: "reconnect" });
    return res.json({ success: true, ...result });
  }
  await audit(req, "store_reconnected", result);
  return res.json({ success: true, store: result });
}

async function pauseStore(req, res) {
  const store = await service.setPaused({ workspaceId: workspaceId(req), storeId: req.params.storeId, paused: true });
  await audit(req, "store_paused", store);
  return res.json({ success: true, store });
}

async function resumeStore(req, res) {
  const store = await service.setPaused({ workspaceId: workspaceId(req), storeId: req.params.storeId, paused: false });
  await audit(req, "store_resumed", store);
  return res.json({ success: true, store });
}

async function disconnectStore(req, res) {
  const store = await service.disconnectStore({ workspaceId: workspaceId(req), storeId: req.params.storeId });
  await audit(req, "store_disconnected", store);
  await audit(req, "webhook_deleted", store, { managedOnly: true });
  return res.json({ success: true, store });
}

async function deleteStore(req, res) {
  const result = await service.deleteStore({ workspaceId: workspaceId(req), storeId: req.params.storeId });
  await audit(req, "store_deleted", result.store || { id: req.params.storeId });
  await audit(req, "webhook_deleted", result.store || { id: req.params.storeId }, { managedOnly: true });
  return res.json({ success: true, deleted: true });
}

async function getHealth(req, res) {
  const result = await service.getHealth({ workspaceId: workspaceId(req), storeId: req.params.storeId });
  return res.json({ success: true, ...result });
}

async function getWebhooks(req, res) {
  const result = await service.getWebhooks({ workspaceId: workspaceId(req), storeId: req.params.storeId });
  return res.json({ success: true, ...result });
}

async function getEvents(req, res) {
  const result = await service.getEvents({ workspaceId: workspaceId(req), storeId: req.params.storeId, limit: req.query.limit });
  return res.json({ success: true, ...result });
}

async function receiveWooCommerceWebhook(req, res) {
  const rawBody = service.rawBodyBuffer(req);
  let payload = {};
  try {
    payload = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    payload = {};
  }
  await service.receiveWooWebhook({
    storeId: req.params.storeId,
    headers: req.headers || {},
    rawBody,
    payload,
  });
  return res.status(202).json({ success: true, accepted: true });
}

async function startShopifyConnect(req, res) {
  const result = await service.startShopifyAuth({ workspaceId: workspaceId(req), userId: userId(req), payload: req.body });
  if (result.state) setShopifyStateCookie(req, res, result.state);
  await audit(req, "shopify_connection_started", { platform: "shopify", storeDomain: result.shopDomain || "" }, { platform: "shopify", storeDomain: result.shopDomain || "" });
  return res.json({ success: true, authorizationUrl: result.authorizationUrl, shopDomain: result.shopDomain || "" });
}

async function continueShopifyInstall(req, res) {
  try {
    const state = readCookie(req, SHOPIFY_STATE_COOKIE);
    const result = await service.continueShopifyInstall({ query: req.query || {}, state });
    return res.redirect(result.authorizationUrl);
  } catch (err) {
    return res.redirect(frontendShopifyRedirect({ shopifyStatus: "error", message: err?.message || "Shopify install could not start" }));
  }
}

async function completeShopifyConnect(req, res) {
  try {
    const store = await service.completeShopifyAuth({ query: req.query || {} });
    clearShopifyStateCookie(res);
    await writeAuditLog(req, {
      action: "store_connected",
      resourceType: "ecommerce_store",
      resourceId: store.id,
      metadata: {
        workspaceId: store.workspaceId,
        platform: "shopify",
        storeDomain: store.storeDomain,
        topics: (store.webhooks || []).map((webhook) => webhook.topic),
      },
    });
    return res.redirect(frontendShopifyRedirect({ shopifyStatus: "connected", store: store.storeDomain || "" }));
  } catch (err) {
    clearShopifyStateCookie(res);
    return res.redirect(frontendShopifyRedirect({ shopifyStatus: "error", message: err?.message || "Shopify connection failed" }));
  }
}

async function receiveShopifyWebhook(req, res) {
  const rawBody = service.rawBodyBuffer(req);
  let payload = {};
  try {
    payload = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    payload = {};
  }
  await service.receiveShopifyWebhook({
    headers: req.headers || {},
    rawBody,
    payload,
  });
  return res.status(202).json({ success: true, accepted: true });
}

module.exports = {
  createStore,
  completeShopifyConnect,
  continueShopifyInstall,
  deleteStore,
  disconnectStore,
  getEvents,
  getHealth,
  getWebhooks,
  listPlatforms,
  listStores,
  pauseStore,
  receiveShopifyWebhook,
  receiveWooCommerceWebhook,
  reconnectStore,
  resumeStore,
  startShopifyConnect,
  updateStore,
};
