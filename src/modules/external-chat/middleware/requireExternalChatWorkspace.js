const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");

function pickHeaderWorkspaceId(req) {
  const value = req.headers["x-workspace-id"];
  if (!value) return "";
  return String(value).trim();
}

async function requireExternalChatWorkspace(req, res, next) {
  try {
    const headerWorkspaceId = pickHeaderWorkspaceId(req);
    let workspace;

    if (headerWorkspaceId) {
      workspace = await Workspace.findOne({
        _id: headerWorkspaceId,
        ownerId: req.user.id,
        isActive: true,
      }).select("_id ownerId name plan isActive allowedApiPermissions features");

      if (!workspace) {
        return next(new HttpError(403, "WORKSPACE_NOT_FOUND", { code: "WORKSPACE_NOT_FOUND" }));
      }
    } else {
      const activeWorkspaces = await Workspace.find({
        ownerId: req.user.id,
        isActive: true,
      })
        .sort({ createdAt: 1 })
        .select("_id ownerId name plan isActive allowedApiPermissions features");

      if (!activeWorkspaces.length) {
        return next(new HttpError(403, "WORKSPACE_NOT_FOUND", { code: "WORKSPACE_NOT_FOUND" }));
      }
      if (activeWorkspaces.length > 1) {
        return next(
          new HttpError(400, "WORKSPACE_REQUIRED: pass x-workspace-id header for users with multiple active workspaces.", {
            code: "WORKSPACE_REQUIRED",
          })
        );
      }
      workspace = activeWorkspaces[0];
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
