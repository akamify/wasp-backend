const { Workspace } = require("@infra/database/Workspace");
const { HttpError } = require("@shared/utils/httpError");

async function requireCrmWorkspaceFromBody(req, res, next) {
  try {
    const workspaceId = String(req.body?.workspaceId || "").trim();
    if (!workspaceId) return next(new HttpError(400, "Missing workspaceId"));

    const workspace = await Workspace.findOne({ _id: workspaceId, isActive: true }).select(
      "_id name plan isActive crmEnabled crmSettings"
    );
    if (!workspace) return next(new HttpError(404, "Workspace not found"));
    if (!workspace.crmEnabled) return next(new HttpError(403, "CRM is disabled for this workspace"));

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

module.exports = { requireCrmWorkspaceFromBody };

