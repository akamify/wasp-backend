const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");

async function authOrApiKey(req, res, next) {
  const header = req.headers.authorization || "";
  const apiKey = req.headers["x-api-key"];

  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    try {
      const payload = jwt.verify(token, jwtSecret);
      const user = await User.findById(payload.sub).select("_id role accountBlocked tokenVersion");
      if (!user) return next(new HttpError(401, "Invalid or expired token"));
      if (user.accountBlocked || String(user.status || "") === "banned") return next(new HttpError(403, "Account blocked"));
      if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
        return next(new HttpError(401, "Session expired. Please login again."));
      }
      req.user = { id: String(user._id), role: user.role, workspaceId: payload.workspaceId, tokenVersion: Number(user.tokenVersion || 0) };
      req.auth = { userId: String(user._id), apiKeyId: null, permissions: null, isApiKey: false };
      return next();
    } catch {
      return next(new HttpError(401, "Invalid or expired token"));
    }
  }

  if (apiKey) {
    const apiKeyHash = sha256Hex(apiKey);
    const user = await User.findOne({
      $or: [{ apiKeyHash }, { "apiKeys.keyHash": apiKeyHash }],
    }).select("_id role accountBlocked allowedApiPermissions apiKeys");
    if (!user) return next(new HttpError(401, "Invalid API key"));
    if (user.accountBlocked || String(user.status || "") === "banned") return next(new HttpError(403, "Account blocked"));
    const keyDoc = Array.isArray(user.apiKeys)
      ? user.apiKeys.find((k) => String(k.keyHash || "") === String(apiKeyHash))
      : null;
    if (keyDoc && keyDoc.revoked) return next(new HttpError(403, "API key revoked"));
    const userAllowedPermissions = user.allowedApiPermissions || { campaignSend: true, chatAccess: false };
    const keyPermissions = keyDoc?.permissions || userAllowedPermissions;
    const permissions = {
      campaignSend: Boolean(userAllowedPermissions?.campaignSend) && Boolean(keyPermissions?.campaignSend),
      chatAccess: Boolean(userAllowedPermissions?.chatAccess) && Boolean(keyPermissions?.chatAccess),
    };
    if (keyDoc) {
      keyDoc.lastUsedAt = new Date();
      await user.save();
    }
    req.user = { id: String(user._id), role: user.role };
    req.auth = {
      userId: String(user._id),
      apiKeyId: keyDoc ? String(keyDoc._id) : null,
      permissions: {
        campaignSend: permissions.campaignSend,
        chatAccess: permissions.chatAccess,
      },
      isApiKey: true,
    };
    return next();
  }

  return next(new HttpError(401, "Missing Authorization or X-API-Key header"));
}

module.exports = { authOrApiKey };

