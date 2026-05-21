const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const repo = require("@modules/api-keys/repositories/apiKey.repository");
const { generateApiKeyRaw } = require("@modules/api-keys/utils/generateApiKey");

function normalizeKeyItem(item) {
  return {
    id: String(item._id),
    name: item.name || "Default",
    permissions: {
      campaignSend: Boolean(item?.permissions?.campaignSend),
      chatAccess: Boolean(item?.permissions?.chatAccess),
    },
    revoked: Boolean(item.revoked),
    revokedAt: item.revokedAt || null,
    createdAt: item.createdAt || null,
    lastUsedAt: item.lastUsedAt || null,
  };
}

async function listMyApiKeys({ userId }) {
  const user = await repo.listApiKeys(userId);
  if (!user) throw new HttpError(404, "User not found");
  return {
    success: true,
    accountBlocked: Boolean(user.accountBlocked),
    allowedApiPermissions: user.allowedApiPermissions || { campaignSend: true, chatAccess: false },
    apiKeys: Array.isArray(user.apiKeys) ? user.apiKeys.map(normalizeKeyItem) : [],
  };
}

async function generateApiKey({ userId, name }) {
  const user = await repo.findUserById(userId, "allowedApiPermissions");
  if (!user) throw new HttpError(404, "User not found");
  const raw = generateApiKeyRaw();
  const keyHash = sha256Hex(raw);
  const created = await repo.addApiKey({
    userId,
    keyHash,
    name: name || "Primary key",
    permissions: {
      campaignSend: user?.allowedApiPermissions?.campaignSend !== false,
      chatAccess: Boolean(user?.allowedApiPermissions?.chatAccess),
    },
  });
  if (!created) throw new HttpError(404, "User not found");
  return { success: true, apiKey: raw, key: normalizeKeyItem(created) };
}

async function regenerateApiKey({ userId, keyId, name }) {
  if (keyId) {
    await repo.revokeApiKey({ userId, keyId });
  } else {
    await repo.clearLegacyApiKey({ userId });
  }
  return generateApiKey({ userId, name: name || "Regenerated key" });
}

async function deleteApiKey({ userId, keyId }) {
  const item = await repo.revokeApiKey({ userId, keyId });
  if (!item) throw new HttpError(404, "API key not found");
  return { success: true };
}

module.exports = {
  listMyApiKeys,
  generateApiKey,
  regenerateApiKey,
  deleteApiKey,
};
