const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { canLoginStatus } = require("@shared/utils/userStatus");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");

async function resolveExternalChatAccessState({ userId, apiKeyId, workspaceId }) {
  const [user, workspace, activeConnection] = await Promise.all([
    User.findById(userId).select("_id status accountBlocked allowedApiPermissions apiKeys"),
    Workspace.findOne({ _id: workspaceId, ownerId: userId, isActive: true }).select("_id allowedApiPermissions features isActive"),
    resolveActiveConnection(workspaceId),
  ]);

  if (!user) return { allowed: false, reason: "user_not_found" };
  if (!canLoginStatus(user.status)) return { allowed: false, reason: "user_inactive" };
  if (user.accountBlocked) return { allowed: false, reason: "user_blocked" };

  const keyDoc = Array.isArray(user.apiKeys) ? user.apiKeys.find((k) => String(k._id) === String(apiKeyId)) : null;
  if (!keyDoc) return { allowed: false, reason: "api_key_not_found" };
  if (keyDoc.revoked) return { allowed: false, reason: "api_key_revoked" };
  if (!activeConnection?.wabaId) return { allowed: false, reason: "whatsapp_not_connected" };
  if (String(keyDoc.workspaceId || "") !== String(workspaceId) || String(keyDoc.wabaId || "") !== String(activeConnection.wabaId)) {
    return { allowed: false, reason: "api_key_previous_whatsapp_account" };
  }

  if (!workspace) return { allowed: false, reason: "workspace_not_found" };
  if (!workspace.isActive) return { allowed: false, reason: "workspace_inactive" };
  if (!workspace.features?.externalChatApiAccess) return { allowed: false, reason: "feature_disabled" };

  const userAllowed = user.allowedApiPermissions || { campaignSend: true, chatAccess: false };
  const keyAllowed = keyDoc.permissions || userAllowed;
  const workspaceAllowed = workspace.allowedApiPermissions || { campaignSend: true, chatAccess: false };

  const chatAccess =
    Boolean(userAllowed.chatAccess) && Boolean(keyAllowed.chatAccess) && Boolean(workspaceAllowed.chatAccess);

  if (!chatAccess) return { allowed: false, reason: "chat_access_denied" };

  return {
    allowed: true,
    reason: "ok",
    keyDoc,
    user,
    workspace,
  };
}

module.exports = { resolveExternalChatAccessState };
