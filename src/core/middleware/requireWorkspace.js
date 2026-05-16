const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");

function pickWorkspaceId(req) {
  return (
    req.headers["x-workspace-id"] ||
    req.query.workspaceId ||
    req.body?.workspaceId ||
    req.user?.workspaceId ||
    null
  );
}

async function requireWorkspace(req, res, next) {
  try {
    let workspaceId = pickWorkspaceId(req);

    // API key flow may not provide x-workspace-id explicitly.
    // In that case, resolve the oldest active workspace for the authenticated owner.
    if (!workspaceId && req.auth?.isApiKey && req.user?.id) {
      const defaultWorkspace = await Workspace.findOne({
        ownerId: req.user.id,
        isActive: true,
      })
        .sort({ createdAt: 1 })
        .select("_id");
      if (defaultWorkspace) workspaceId = String(defaultWorkspace._id);
    }

    if (!workspaceId) return next(new HttpError(400, "Missing workspaceId"));

    const workspace = await Workspace.findOne({
      _id: workspaceId,
      ownerId: req.user.id,
      isActive: true,
    }).select("_id ownerId name plan isActive createdAt");

    if (!workspace) return next(new HttpError(404, "Workspace not found"));

    req.workspace = {
      id: String(workspace._id),
      name: workspace.name,
      plan: workspace.plan,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireWorkspace };

