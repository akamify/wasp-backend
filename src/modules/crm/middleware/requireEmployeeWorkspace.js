const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");

async function requireEmployeeWorkspace(req, res, next) {
  try {
    const workspaceId = String(req.employee?.workspaceId || "").trim();
    if (!workspaceId) return next(new HttpError(400, "Missing workspaceId"));

    const workspace = await Workspace.findOne({ _id: workspaceId, isActive: true }).select(
      "_id ownerId name plan isActive createdAt crmEnabled crmSettings"
    );
    if (!workspace) return next(new HttpError(404, "Workspace not found"));

    req.workspace = {
      id: String(workspace._id),
      name: workspace.name,
      plan: workspace.plan,
      crmEnabled: Boolean(workspace.crmEnabled),
      crmSettings: workspace.crmSettings || {},
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireEmployeeWorkspace };
