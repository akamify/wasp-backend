const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

async function requireExternalChatWorkspace(req, res, next) {
  try {
    const apiKeyWorkspaceId = String(req.auth?.workspaceId || "").trim();
    if (!apiKeyWorkspaceId) {
      return next(new HttpError(403, "API key is not scoped to a workspace", { code: "WORKSPACE_NOT_FOUND" }));
    }

    const workspace = await Workspace.findOne({
      _id: apiKeyWorkspaceId,
      ownerId: req.user.id,
      isActive: true,
    }).select("_id ownerId name plan isActive allowedApiPermissions features");

    if (!workspace) {
      return next(new HttpError(403, "WORKSPACE_NOT_FOUND", { code: "WORKSPACE_NOT_FOUND" }));
    }

    req.workspace = {
      id: String(workspace._id),
      name: workspace.name,
      plan: workspace.plan,
      isActive: Boolean(workspace.isActive),
      allowedApiPermissions: {
        campaignSend: Boolean(workspace?.allowedApiPermissions?.campaignSend ?? true),
        chatAccess: Boolean(workspace?.allowedApiPermissions?.chatAccess ?? false),
      },
      features: {
        externalChatApiAccess: Boolean(workspace?.features?.externalChatApiAccess),
      },
    };

    const scope = await requireActiveWabaScope(req.workspace.id);
    if (String(req.auth?.workspaceId || "") !== scope.workspaceId || String(req.auth?.wabaId || "") !== scope.wabaId) {
      return next(new HttpError(403, "This API key belongs to a previous WhatsApp account. Generate a new API key for the current account."));
    }

    if (req.auth?.permissions) {
      req.auth.permissions = {
        campaignSend: Boolean(req.auth.permissions.campaignSend) && Boolean(req.workspace.allowedApiPermissions.campaignSend),
        chatAccess: Boolean(req.auth.permissions.chatAccess) && Boolean(req.workspace.allowedApiPermissions.chatAccess),
      };
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireExternalChatWorkspace };
