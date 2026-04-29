const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");

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
    const workspaceId = pickWorkspaceId(req);
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

