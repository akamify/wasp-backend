const mongoose = require("mongoose");
const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");

async function findUserById(userId, select = "") {
  return User.findById(userId).select(select);
}

async function findUserByApiKeyHash(keyHash, select = "") {
  return User.findOne({ $or: [{ apiKeyHash: keyHash }, { "apiKeys.keyHash": keyHash }] }).select(select);
}

async function listApiKeys(userId) {
  const user = await User.findById(userId).select("apiKeys allowedApiPermissions accountBlocked");
  if (!user) return null;
  return user;
}

async function addApiKey({ userId, keyHash, name, permissions }) {
  const user = await User.findById(userId).select("+apiKeys");
  if (!user) return null;
  user.apiKeys = Array.isArray(user.apiKeys) ? user.apiKeys : [];
  user.apiKeys.push({
    name: name || "Default",
    keyHash,
    permissions: {
      campaignSend: permissions?.campaignSend !== false,
      chatAccess: Boolean(permissions?.chatAccess),
    },
    revoked: false,
  });
  await user.save();
  return user.apiKeys[user.apiKeys.length - 1];
}

async function revokeApiKey({ userId, keyId }) {
  const user = await User.findById(userId).select("+apiKeys");
  if (!user) return null;
  const item = (user.apiKeys || []).id(keyId);
  if (!item) return null;
  item.revoked = true;
  item.revokedAt = new Date();
  await user.save();
  return item;
}

async function updateApiKeyState({ userId, keyId, revoked }) {
  const user = await User.findById(userId).select("+apiKeys");
  if (!user) return null;
  const item = (user.apiKeys || []).id(keyId);
  if (!item) return null;
  item.revoked = Boolean(revoked);
  item.revokedAt = item.revoked ? new Date() : null;
  await user.save();
  return item;
}

async function updateApiKeyPermissions({ userId, keyId, permissions }) {
  const user = await User.findById(userId).select("+apiKeys");
  if (!user) return null;
  const item = (user.apiKeys || []).id(keyId);
  if (!item) return null;
  item.permissions = {
    campaignSend: permissions?.campaignSend !== false,
    chatAccess: Boolean(permissions?.chatAccess),
  };
  await user.save();
  return item;
}

async function updateApiKeyChatAccess({ userId, keyId, enabled }) {
  const user = await User.findById(userId).select("+apiKeys");
  if (!user) return null;
  const item = (user.apiKeys || []).id(keyId);
  if (!item) return null;
  item.permissions = item.permissions || {};
  item.permissions.chatAccess = Boolean(enabled);
  if (item.permissions.campaignSend === undefined) {
    item.permissions.campaignSend = true;
  }
  await user.save();
  return item;
}

async function updateUserSecurityFlags({ userId, patch }) {
  return User.findByIdAndUpdate(userId, patch, { new: true }).select("accountBlocked tokenVersion allowedApiPermissions chatAccessEnabledBy chatAccessEnabledAt");
}

async function syncAllApiKeysChatAccess({ userId, enabled }) {
  await User.updateOne(
    { _id: userId, "apiKeys.0": { $exists: true } },
    { $set: { "apiKeys.$[k].permissions.chatAccess": !!enabled } },
    { arrayFilters: [{ "k.revoked": { $ne: true } }] }
  );
}

async function syncAllNonRevokedApiKeysChatAccess({ userId, enabled }) {
  await User.updateOne(
    { _id: userId, "apiKeys.0": { $exists: true } },
    { $set: { "apiKeys.$[k].permissions.chatAccess": !!enabled } },
    { arrayFilters: [{ "k.revoked": { $ne: true } }] }
  );
}

async function syncWorkspaceChatAccessByOwner({ ownerId, enabled }) {
  await Workspace.updateMany(
    { ownerId, isActive: true },
    { $set: { "allowedApiPermissions.chatAccess": !!enabled } }
  );
}

async function clearLegacyApiKey({ userId }) {
  return User.findByIdAndUpdate(
    userId,
    { $set: { apiKeyHash: null, apiKeyEnc: null } },
    { new: true }
  ).select("_id");
}

async function setApiKeyOtp({ userId, otpHash, expiresAt, purpose, keyId }) {
  return User.findByIdAndUpdate(
    userId,
    {
      $set: {
        apiKeyOtpCodeHash: otpHash,
        apiKeyOtpCodeExpiresAt: expiresAt,
        apiKeyOtpPurpose: purpose,
        apiKeyOtpKeyId: keyId || null,
      },
      $inc: { apiKeyOtpAttempts: 0 },
    },
    { new: true }
  ).select("+apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose +apiKeyOtpAttempts +apiKeyOtpKeyId email name");
}

async function findUserForApiKeyOtp(userId) {
  return User.findById(userId).select("+apiKeyOtpCodeHash +apiKeyOtpCodeExpiresAt +apiKeyOtpPurpose +apiKeyOtpAttempts +apiKeyOtpKeyId email name");
}

module.exports = {
  mongoose,
  findUserById,
  findUserByApiKeyHash,
  listApiKeys,
  addApiKey,
  revokeApiKey,
  updateApiKeyState,
  updateApiKeyPermissions,
  updateApiKeyChatAccess,
  updateUserSecurityFlags,
  syncAllApiKeysChatAccess,
  syncAllNonRevokedApiKeysChatAccess,
  syncWorkspaceChatAccessByOwner,
  clearLegacyApiKey,
  setApiKeyOtp,
  findUserForApiKeyOtp,
};
