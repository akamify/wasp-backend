const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");

async function deny(req, next, reason) {
  await writeAuditLog(req, {
    action: "external_chat.access_denied",
    resourceType: "external_chat",
    resourceId: req.auth?.apiKeyId || req.workspace?.id || req.user?.id,
    metadata: {
      workspaceId: req.workspace?.id || null,
      apiKeyId: req.auth?.apiKeyId || null,
      reason,
    },
  });

  return next(new HttpError(403, "External chat access denied", { code: "EXTERNAL_CHAT_ACCESS_DENIED", reason }));
}

async function requireExternalChatAccess(req, res, next) {
  if (!req.auth?.isApiKey) return deny(req, next, "api_key_missing");
  // Chat entitlement is controlled by workspace feature toggle only.
  if (!req.workspace?.features?.externalChatApiAccess) return deny(req, next, "external_chat_feature_disabled");
  return next();
}

module.exports = { requireExternalChatAccess };
