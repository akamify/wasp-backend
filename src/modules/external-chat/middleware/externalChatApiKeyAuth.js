const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

async function externalChatApiKeyAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || "").trim();
  const bearerApiKey = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const rawApiKey = bearerApiKey || req.headers["x-api-key"];

  if (!rawApiKey || typeof rawApiKey !== "string") {
    console.info("[external-api] denied", { reason: "api_key_missing", keyPrefix: null });
    return next(new HttpError(401, "Invalid API key", { code: "invalid_api_key", reason: "api_key_missing" }));
  }

  const apiKey = rawApiKey.trim();
  const keyPrefix = apiKey.slice(0, 8);

  if (!apiKey) {
    console.info("[external-api] denied", { reason: "api_key_missing", keyPrefix: null });
    return next(new HttpError(401, "Invalid API key", { code: "invalid_api_key", reason: "api_key_missing" }));
  }

  const apiKeyHash = sha256Hex(apiKey);

  const user = await User.findOne({
    "apiKeys.keyHash": apiKeyHash,
  }).select(
    "_id role status terminationState accountBlocked allowedApiPermissions " +
    "apiKeys._id apiKeys.workspaceId apiKeys.wabaId apiKeys.name apiKeys.keyPrefix apiKeys.permissions apiKeys.status apiKeys.revoked apiKeys.revokedAt apiKeys.lastUsedAt " +
    "+apiKeys.keyHash"
  )

  if (!user) {
    console.info("[external-api] denied", { reason: "api_key_invalid", keyPrefix });
    return next(new HttpError(401, "Invalid API key", { code: "invalid_api_key", reason: "api_key_invalid" }));
  }

  if (!canLoginStatus(user.status)) {
    return next(new HttpError(403, getBlockedLoginMessage(user.status)));
  }

  if (user.accountBlocked) {
    console.info("[external-api] denied", { reason: "user_blocked", keyPrefix });
    return next(new HttpError(403, "This user is inactive", { code: "invalid_api_key", reason: "user_blocked" }));
  }

  const keyDoc = Array.isArray(user.apiKeys)
    ? user.apiKeys.find((k) => String(k.keyHash || "") === String(apiKeyHash))
    : null;

  if (!keyDoc) {
    console.info("[external-api] denied", { reason: "api_key_invalid", keyPrefix });
    return next(new HttpError(401, "Invalid API key", { code: "invalid_api_key", reason: "api_key_invalid" }));
  }
  if (keyDoc.revoked || keyDoc.status === "disabled") {
    console.info("[external-api] denied", { reason: "api_key_revoked", keyPrefix });
    return next(new HttpError(403, "API key revoked", { code: "invalid_api_key", reason: "api_key_revoked" }));
  }

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
  const explicitScopes = Array.isArray(keyPermissions.scopes)
    ? keyPermissions.scopes.map((scope) => String(scope || "").trim()).filter(Boolean)
    : [];
  const scopes = new Set(explicitScopes);
  if (permissions.chatAccess) {
    [
      "contacts:read",
      "contacts:write",
      "conversations:read",
      "messages:read",
      "messages:send",
      "webhooks:write",
    ].forEach((scope) => scopes.add(scope));
  }

  keyDoc.lastUsedAt = new Date();
  await user.save();

  req.user = { id: String(user._id), role: user.role };

  req.auth = {
    userId: String(user._id),
    apiKeyId: String(keyDoc._id),
    workspaceId: keyDoc.workspaceId ? String(keyDoc.workspaceId) : null,
    wabaId: keyDoc.wabaId ? String(keyDoc.wabaId) : null,
    permissions,
    scopes: Array.from(scopes),
    keyPrefix: keyDoc.keyPrefix || keyPrefix,
    isApiKey: true,
  };
  console.info("[external-api] authenticated", {
    workspaceId: req.auth.workspaceId,
    keyPrefix: req.auth.keyPrefix,
    scopes: req.auth.scopes,
  });

  return next();
}

module.exports = { externalChatApiKeyAuth };
