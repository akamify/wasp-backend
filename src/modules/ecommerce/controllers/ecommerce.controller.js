const service = require("@modules/ecommerce/services/ecommerceStore.service");
const { writeAuditLog } = require("@shared/services/auditLog.service");

function workspaceId(req) {
  return String(req.workspace?.id || "");
}

function userId(req) {
  return String(req.user?.id || "");
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
  const store = await service.reconnectStore({ workspaceId: workspaceId(req), storeId: req.params.storeId });
  await audit(req, "store_reconnected", store);
  return res.json({ success: true, store });
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
  await audit(req, "store_deleted", { id: req.params.storeId, platform: "woocommerce" });
  await audit(req, "webhook_deleted", { id: req.params.storeId, platform: "woocommerce" }, { managedOnly: true });
  return res.json({ success: true, ...result });
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

module.exports = {
  createStore,
  deleteStore,
  disconnectStore,
  getEvents,
  getHealth,
  getWebhooks,
  listPlatforms,
  listStores,
  pauseStore,
  receiveWooCommerceWebhook,
  reconnectStore,
  resumeStore,
  updateStore,
};
