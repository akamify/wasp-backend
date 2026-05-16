const { Workspace } = require("@infra/database/Workspace");

async function listActiveWorkspacesForOwner(ownerId) {
  return Workspace.find({ ownerId, isActive: true }).sort({ createdAt: 1 }).select("_id name plan createdAt");
}

async function createWorkspace({ ownerId, name }) {
  return Workspace.create({ ownerId, name });
}

module.exports = {
  listActiveWorkspacesForOwner,
  createWorkspace,
};

