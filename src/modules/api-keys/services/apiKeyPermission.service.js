const { HttpError } = require("@shared/utils/httpError");
const repo = require("@modules/api-keys/repositories/apiKey.repository");
const { writeAuditLog } = require("@shared/services/auditLog.service");

async function enableChatAccess({ req, adminUserId, userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: {
      $set: {
        "allowedApiPermissions.chatAccess": true,
        chatAccessEnabledBy: adminUserId,
        chatAccessEnabledAt: new Date(),
      },
    },
  });
  if (!updated) throw new HttpError(404, "User not found");

  // IMPORTANT: do not auto-enable chatAccess on all API keys or all workspaces.
  // Key-level permission and workspace entitlement are separate layers.
  await writeAuditLog(req, {
    action: "api_key.chat_access_enabled",
    resourceType: "user",
    resourceId: String(userId),
    metadata: {
      userId: String(userId),
      enabled: true,
      actorId: req?.user?.id || null,
      actorRole: req?.user?.role || null,
    },
  });
  return { success: true };
}

async function disableChatAccess({ req, userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: { $set: { "allowedApiPermissions.chatAccess": false } },
  });
  if (!updated) throw new HttpError(404, "User not found");
  await writeAuditLog(req, {
    action: "api_key.chat_access_disabled",
    resourceType: "user",
    resourceId: String(userId),
    metadata: {
      userId: String(userId),
      enabled: false,
      actorId: req?.user?.id || null,
      actorRole: req?.user?.role || null,
    },
  });
  return { success: true };
}

async function enableCampaignSend({ userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: { $set: { "allowedApiPermissions.campaignSend": true } },
  });
  if (!updated) throw new HttpError(404, "User not found");
  return { success: true };
}

async function disableCampaignSend({ userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: { $set: { "allowedApiPermissions.campaignSend": false } },
  });
  if (!updated) throw new HttpError(404, "User not found");
  return { success: true };
}

async function blockUser({ userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: {
      $set: { accountBlocked: true },
      $inc: { tokenVersion: 1 },
    },
  });
  if (!updated) throw new HttpError(404, "User not found");
  return { success: true };
}

async function unblockUser({ userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: { $set: { accountBlocked: false } },
  });
  if (!updated) throw new HttpError(404, "User not found");
  return { success: true };
}

async function setUserApiKeyState({ userId, keyId, revoked }) {
  const key = await repo.updateApiKeyState({ userId, keyId, revoked });
  if (!key) throw new HttpError(404, "API key not found");
  return { success: true };
}

async function setApiKeyChatAccess({ req, userId, keyId, enabled }) {
  const key = await repo.updateApiKeyChatAccess({ userId, keyId, enabled });
  if (!key) throw new HttpError(404, "API key not found");

  if (enabled) {
    // Key can only be effective when user-level permission is also enabled.
    await repo.updateUserSecurityFlags({
      userId,
      patch: { $set: { "allowedApiPermissions.chatAccess": true } },
    });
  }

  await writeAuditLog(req, {
    action: enabled ? "api_key.chat_access_enabled" : "api_key.chat_access_disabled",
    resourceType: "api_key",
    resourceId: String(keyId),
    metadata: {
      userId: String(userId),
      apiKeyId: String(keyId),
      enabled: Boolean(enabled),
      actorId: req?.user?.id || null,
      actorRole: req?.user?.role || null,
    },
  });

  return {
    success: true,
    message: "API key chat access updated successfully.",
    data: {
      apiKey: {
        id: String(key._id),
        permissions: {
          campaignSend: Boolean(key?.permissions?.campaignSend),
          chatAccess: Boolean(key?.permissions?.chatAccess),
        },
        revoked: Boolean(key.revoked),
      },
    },
  };
}

async function bulkSyncApiKeysChatAccess({ req, userId, enabled }) {
  await repo.syncAllNonRevokedApiKeysChatAccess({ userId, enabled });

  if (enabled) {
    await repo.updateUserSecurityFlags({ userId, patch: { $set: { "allowedApiPermissions.chatAccess": true } } });
  }

  await writeAuditLog(req, {
    action: "api_key.chat_access_bulk_synced",
    resourceType: "user",
    resourceId: String(userId),
    metadata: {
      userId: String(userId),
      enabled: Boolean(enabled),
      actorId: req?.user?.id || null,
      actorRole: req?.user?.role || null,
    },
  });

  return { success: true, message: "API key chat access bulk sync completed successfully." };
}

module.exports = {
  enableChatAccess,
  disableChatAccess,
  enableCampaignSend,
  disableCampaignSend,
  blockUser,
  unblockUser,
  setUserApiKeyState,
  setApiKeyChatAccess,
  bulkSyncApiKeysChatAccess,
};
