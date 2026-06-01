const { workspacesService } = require("@modules/workspaces/services/index");

async function listWorkspaces(req, res) {
  const body = await workspacesService.listWorkspaces({ ownerId: req.user.id });
  res.json(body);
}

async function createWorkspace(req, res) {
  const body = await workspacesService.createWorkspace({ ownerId: req.user.id, payload: req.body });
  res.status(201).json(body);
}

async function getWorkspaceOverview(req, res) {
  res.json(await workspacesService.getWorkspaceOverview({ workspaceId: req.params.workspaceId, userId: req.user.id }));
}

async function updateWorkspace(req, res) {
  res.json(await workspacesService.updateWorkspace({ workspaceId: req.params.workspaceId, userId: req.user.id, payload: req.body }));
}

async function listMembers(req, res) {
  res.json(await workspacesService.listMembers({ workspaceId: req.params.workspaceId, userId: req.user.id }));
}

async function listUsage(req, res) {
  res.json(await workspacesService.listUsage({ workspaceId: req.params.workspaceId, userId: req.user.id }));
}

async function listActivity(req, res) {
  res.json(await workspacesService.listActivity({ workspaceId: req.params.workspaceId, userId: req.user.id }));
}

async function inviteMember(req, res) {
  res.status(201).json(await workspacesService.inviteMember({ workspaceId: req.params.workspaceId, userId: req.user.id, payload: req.body }));
}

async function updateMember(req, res) {
  res.json(await workspacesService.updateMember({ workspaceId: req.params.workspaceId, memberId: req.params.memberId, userId: req.user.id, payload: req.body }));
}

module.exports = {
  listWorkspaces,
  createWorkspace,
  getWorkspaceOverview,
  updateWorkspace,
  listMembers,
  listUsage,
  listActivity,
  inviteMember,
  updateMember,
};

