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
  if (!req.workspace?.features?.externalChatApiAccess) return deny(req, next, "external_chat_feature_disabled");
  if (!req.auth?.permissions?.chatAccess) return deny(req, next, "chat_access_disabled");
  return next();
}

function requireExternalChatScope(scope) {
  return async (req, res, next) => {
    if (!scope) return next();
    const scopes = new Set((req.auth?.scopes || []).map((item) => String(item || "").trim()));
    if (scopes.has(scope)) return next();
    console.info("[external-api] denied", {
      reason: "missing_scope",
      keyPrefix: req.auth?.keyPrefix || null,
      scope,
    });
    await writeAuditLog(req, {
      action: "external_chat.access_denied",
      resourceType: "external_chat",
      resourceId: req.auth?.apiKeyId || req.workspace?.id || req.user?.id,
      metadata: {
        workspaceId: req.workspace?.id || null,
        apiKeyId: req.auth?.apiKeyId || null,
        reason: "missing_scope",
        scope,
      },
    });
    return next(new HttpError(403, "API key missing required scope", { code: "missing_scope", scope }));
  };
}

module.exports = { requireExternalChatAccess, requireExternalChatScope };
