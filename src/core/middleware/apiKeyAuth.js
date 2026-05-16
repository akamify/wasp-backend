const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string") {
    return next(new HttpError(401, "Missing X-API-Key header"));
  }

  const apiKeyHash = sha256Hex(apiKey);
  const user = await User.findOne({
    $or: [{ apiKeyHash }, { "apiKeys.keyHash": apiKeyHash }],
  }).select("_id role accountBlocked allowedApiPermissions apiKeys");
  if (!user) return next(new HttpError(401, "Invalid API key"));
  if (user.accountBlocked || String(user.status || "") === "banned") {
    return next(new HttpError(403, "Account blocked"));
  }

  const keyDoc = Array.isArray(user.apiKeys)
    ? user.apiKeys.find((k) => String(k.keyHash || "") === String(apiKeyHash))
    : null;
  if (keyDoc && keyDoc.revoked) return next(new HttpError(403, "API key revoked"));

  const permissions = keyDoc?.permissions || user.allowedApiPermissions || { campaignSend: true, chatAccess: false };
  if (keyDoc) {
    keyDoc.lastUsedAt = new Date();
    await user.save();
  }

  req.user = { id: String(user._id), role: user.role };
  req.auth = {
    userId: String(user._id),
    apiKeyId: keyDoc ? String(keyDoc._id) : null,
    permissions: {
      campaignSend: Boolean(permissions?.campaignSend),
      chatAccess: Boolean(permissions?.chatAccess),
    },
    isApiKey: true,
  };
  return next();
}

module.exports = { apiKeyAuth };

