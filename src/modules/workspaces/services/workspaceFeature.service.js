const Joi = require("joi");
const { HttpError } = require("@shared/utils/httpError");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { workspacesRepository } = require("@modules/workspaces/repositories/index");
const apiKeyRepo = require("@modules/api-keys/repositories/apiKey.repository");

const toggleExternalChatSchema = Joi.object({
  enabled: Joi.boolean().required(),
});

async function toggleExternalChatFeature({ req, workspaceId, payload }) {
  const validated = await toggleExternalChatSchema.validateAsync(payload || {}, {
    abortEarly: false,
    stripUnknown: true,
  });

  const workspace = await workspacesRepository.findActiveWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  const updated = await workspacesRepository.setExternalChatFeature({
    workspaceId,
    enabled: Boolean(validated.enabled),
  });
  if (!updated) throw new HttpError(404, "Workspace not found");

  const enabled = Boolean(updated?.features?.externalChatApiAccess);
  const ownerId = workspace.ownerId || updated.ownerId;
  if (ownerId) {
    await apiKeyRepo.updateUserSecurityFlags({
      userId: ownerId,
      patch: {
        $set: {
          "allowedApiPermissions.chatAccess": enabled,
          ...(enabled
            ? {
                chatAccessEnabledBy: req.user?.id || null,
                chatAccessEnabledAt: new Date(),
              }
            : {}),
        },
      },
    });
    await apiKeyRepo.syncAllNonRevokedApiKeysChatAccess({ userId: ownerId, enabled });
  }

  await writeAuditLog(req, {
    action: enabled
      ? "workspace.external_chat_feature_enabled"
      : "workspace.external_chat_feature_disabled",
    resourceType: "workspace",
    resourceId: String(updated._id),
    metadata: {
      workspaceId: String(updated._id),
      userId: String(updated.ownerId || ""),
      enabled,
      actorId: req.user?.id || null,
      actorRole: req.user?.role || null,
    },
  });

  return {
    success: true,
    message: "External Chat API feature updated successfully.",
    data: {
      workspace: {
        id: String(updated._id),
        features: {
          externalChatApiAccess: enabled,
        },
        allowedApiPermissions: {
          chatAccess: Boolean(updated?.allowedApiPermissions?.chatAccess),
        },
      },
    },
  };
}

async function getExternalChatFeature({ workspaceId }) {
  const workspace = await workspacesRepository.findActiveWorkspaceById(workspaceId);
  if (!workspace) throw new HttpError(404, "Workspace not found");

  return {
    success: true,
    message: "OK",
    data: {
      workspace: {
        id: String(workspace._id),
        features: {
          externalChatApiAccess: Boolean(workspace?.features?.externalChatApiAccess),
        },
        allowedApiPermissions: {
          chatAccess: Boolean(workspace?.allowedApiPermissions?.chatAccess),
        },
      },
    },
  };
}

module.exports = {
  toggleExternalChatFeature,
  getExternalChatFeature,
};
