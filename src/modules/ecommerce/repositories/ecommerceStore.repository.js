const mongoose = require("mongoose");
const { EcommerceStore } = require("@infra/database/EcommerceStore");
const { EcommerceEvent } = require("@infra/database/EcommerceEvent");

function byWorkspace(workspaceId, extra = {}) {
  return { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)), deletedAt: null, ...extra };
}

async function listStores({ workspaceId, platform }) {
  const q = byWorkspace(workspaceId);
  if (platform) q.platform = String(platform).toLowerCase();
  return EcommerceStore.find(q).sort({ updatedAt: -1 }).lean();
}

async function findStoreById({ workspaceId, storeId }) {
  if (!mongoose.Types.ObjectId.isValid(String(storeId))) return null;
  return EcommerceStore.findOne(byWorkspace(workspaceId, { _id: storeId }));
}

async function findDuplicate({ workspaceId, platform, storeUrl, excludeId }) {
  const q = byWorkspace(workspaceId, { platform, storeUrl });
  if (excludeId) q._id = { $ne: excludeId };
  return EcommerceStore.findOne(q).lean();
}

async function createStore(payload) {
  return EcommerceStore.create(payload);
}

async function listEvents({ workspaceId, storeId, limit = 50 }) {
  return EcommerceEvent.find({
    workspaceId,
    storeId,
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit || 50), 1), 100))
    .lean();
}

async function findStoreForWebhook(storeId) {
  if (!mongoose.Types.ObjectId.isValid(String(storeId))) return null;
  return EcommerceStore.findOne({ _id: storeId, deletedAt: null });
}

async function createEvent(payload) {
  return EcommerceEvent.create(payload);
}

module.exports = {
  createStore,
  createEvent,
  findDuplicate,
  findStoreForWebhook,
  findStoreById,
  listEvents,
  listStores,
};
