const mongoose = require("mongoose");
const { EcommerceStore } = require("@infra/database/EcommerceStore");
const { EcommerceEvent } = require("@infra/database/EcommerceEvent");
const { EcommerceAuthState } = require("@infra/database/EcommerceAuthState");

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

async function findByPlatformDomain({ workspaceId, platform, storeDomain, excludeId }) {
  const q = byWorkspace(workspaceId, { platform, storeDomain: String(storeDomain || "").toLowerCase() });
  if (excludeId) q._id = { $ne: excludeId };
  return EcommerceStore.findOne(q);
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

async function findStoreForShopifyWebhook(shopDomain) {
  return EcommerceStore.findOne({
    platform: "shopify",
    storeDomain: String(shopDomain || "").toLowerCase(),
    deletedAt: null,
  });
}

async function createAuthState(payload) {
  return EcommerceAuthState.create(payload);
}

async function consumeAuthState({ stateHash }) {
  return EcommerceAuthState.findOneAndUpdate(
    { stateHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { returnDocument: "after" }
  );
}

async function createEvent(payload) {
  return EcommerceEvent.create(payload);
}

module.exports = {
  createStore,
  createEvent,
  createAuthState,
  findDuplicate,
  findByPlatformDomain,
  findStoreForWebhook,
  findStoreById,
  findStoreForShopifyWebhook,
  consumeAuthState,
  listEvents,
  listStores,
};
