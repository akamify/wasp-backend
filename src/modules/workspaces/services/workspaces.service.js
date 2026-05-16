const { HttpError } = require("@shared/utils/httpError");
const { workspacesRepository } = require("@modules/workspaces/repositories/index");
const { mapWorkspaceListItem, mapWorkspaceCreated } = require("@modules/workspaces/dto/workspaces.dto");
const { emitWorkspaceCreated } = require("@modules/workspaces/events/index");

async function listWorkspaces({ ownerId }) {
  const items = await workspacesRepository.listActiveWorkspacesForOwner(ownerId);
  return { success: true, workspaces: items.map(mapWorkspaceListItem) };
}

async function createWorkspace({ ownerId, name }) {
  const normalized = String(name || "").trim();
  if (!normalized) throw new HttpError(400, "Workspace name is required");

  const workspace = await workspacesRepository.createWorkspace({ ownerId, name: normalized });

  // Non-breaking: emitting events has no side effects unless listeners are added.
  emitWorkspaceCreated({ workspaceId: String(workspace._id), ownerId: String(ownerId) });

  return { success: true, workspace: mapWorkspaceCreated(workspace) };
}

module.exports = {
  listWorkspaces,
  createWorkspace,
};
