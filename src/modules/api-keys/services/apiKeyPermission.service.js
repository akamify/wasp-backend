const { HttpError } = require("@shared/utils/httpError");
const repo = require("@modules/api-keys/repositories/apiKey.repository");

async function enableChatAccess({ adminUserId, userId }) {
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
  return { success: true };
}

async function disableChatAccess({ userId }) {
  const updated = await repo.updateUserSecurityFlags({
    userId,
    patch: { $set: { "allowedApiPermissions.chatAccess": false } },
  });
  if (!updated) throw new HttpError(404, "User not found");
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

module.exports = {
  enableChatAccess,
  disableChatAccess,
  enableCampaignSend,
  disableCampaignSend,
  blockUser,
  unblockUser,
  setUserApiKeyState,
};
