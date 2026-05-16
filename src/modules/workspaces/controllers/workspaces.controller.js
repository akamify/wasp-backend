const { workspacesService } = require("@modules/workspaces/services/index");

async function listWorkspaces(req, res) {
  const body = await workspacesService.listWorkspaces({ ownerId: req.user.id });
  res.json(body);
}

async function createWorkspace(req, res) {
  const body = await workspacesService.createWorkspace({ ownerId: req.user.id, name: req.body?.name });
  res.status(201).json(body);
}

module.exports = {
  listWorkspaces,
  createWorkspace,
};

