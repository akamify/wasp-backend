const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { HttpError } = require("@shared/utils/httpError");
const { sha256Hex } = require("@shared/utils/hash");
const { User } = require("@infra/database/User");
const { canLoginStatus, getBlockedLoginMessage } = require("@shared/utils/userStatus");

async function authOrApiKey(req, res, next) {
  const header = req.headers.authorization || "";
  const apiKey = req.headers["x-api-key"];

  if (header.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    try {
      const payload = jwt.verify(token, jwtSecret);
      const user = await User.findById(payload.sub).select(
        "_id role status terminationState accountBlocked tokenVersion allowedApiPermissions"
      );
      if (!user) return next(new HttpError(401, "Invalid or expired token"));
      if (!canLoginStatus(user.status)) return next(new HttpError(403, getBlockedLoginMessage(user.status)));
      if (user.accountBlocked) return next(new HttpError(403, "This user is inactive"));
      if (Number(payload.tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
        return next(new HttpError(401, "Session expired. Please login again."));
      }
      req.user = { id: String(user._id), role: user.role, workspaceId: payload.workspaceId, tokenVersion: Number(user.tokenVersion || 0) };
      const userAllowedPermissions = user.allowedApiPermissions || { campaignSend: true, chatAccess: false };
      req.auth = {
        userId: String(user._id),
        apiKeyId: null,
        permissions: {
          campaignSend: Boolean(userAllowedPermissions?.campaignSend),
          chatAccess: Boolean(userAllowedPermissions?.chatAccess),
        },
        isApiKey: false,
      };
      return next();
    } catch {
      return next(new HttpError(401, "Invalid or expired token"));
    }
  }

  if (apiKey) {
    const apiKeyHash = sha256Hex(apiKey);
    const user = await User.findOne({
      $or: [{ apiKeyHash }, { "apiKeys.keyHash": apiKeyHash }],
    }).select("_id role status terminationState accountBlocked allowedApiPermissions apiKeys");
    if (!user) return next(new HttpError(401, "Invalid API key"));
    if (!canLoginStatus(user.status)) return next(new HttpError(403, getBlockedLoginMessage(user.status)));
    if (user.accountBlocked) return next(new HttpError(403, "This user is inactive"));
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

