const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

async function externalChatApiKeyAuth(req, res, next) {
  const rawApiKey = req.headers["x-api-key"];

  if (!rawApiKey || typeof rawApiKey !== "string") {
    return next(new HttpError(401, "Missing X-API-Key header", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "api_key_missing" }));
  }

  const apiKey = rawApiKey.trim();

  if (!apiKey) {
    return next(new HttpError(401, "Missing X-API-Key header", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "api_key_missing" }));
  }

  const apiKeyHash = sha256Hex(apiKey);

  const user = await User.findOne({
    "apiKeys.keyHash": apiKeyHash,
  }).select(
    "_id role status terminationState accountBlocked allowedApiPermissions " +
    "apiKeys._id apiKeys.workspaceId apiKeys.wabaId apiKeys.name apiKeys.permissions apiKeys.revoked apiKeys.revokedAt apiKeys.lastUsedAt " +
    "+apiKeys.keyHash"
  )

  if (!user) return next(new HttpError(401, "Invalid API key", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "api_key_invalid" }));

  if (!canLoginStatus(user.status)) {
    return next(new HttpError(403, getBlockedLoginMessage(user.status)));
  }

  if (user.accountBlocked) {
    return next(new HttpError(403, "This user is inactive", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "user_blocked" }));
  }

  const keyDoc = Array.isArray(user.apiKeys)
    ? user.apiKeys.find((k) => String(k.keyHash || "") === String(apiKeyHash))
    : null;

  if (!keyDoc) return next(new HttpError(401, "Invalid API key", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "api_key_invalid" }));
  if (keyDoc.revoked) return next(new HttpError(403, "API key revoked", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason: "api_key_revoked" }));

  const userAllowedPermissions = user.allowedApiPermissions || {
    campaignSend: true,
    chatAccess: false,
  };

  const keyPermissions = keyDoc.permissions || {};

  const permissions = {
    campaignSend:
      Boolean(userAllowedPermissions.campaignSend) &&
      Boolean(keyPermissions.campaignSend),
    chatAccess:
      Boolean(userAllowedPermissions.chatAccess) &&
      Boolean(keyPermissions.chatAccess),
  };

  keyDoc.lastUsedAt = new Date();
  await user.save();

  req.user = { id: String(user._id), role: user.role };

  req.auth = {
    userId: String(user._id),
    apiKeyId: String(keyDoc._id),
    workspaceId: keyDoc.workspaceId ? String(keyDoc.workspaceId) : null,
    wabaId: keyDoc.wabaId ? String(keyDoc.wabaId) : null,
    permissions,
    isApiKey: true,
  };

  return next();
}

module.exports = { externalChatApiKeyAuth };
