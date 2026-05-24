const { Workspace } = require("@infra/database/Workspace");

async function listActiveWorkspacesForOwner(ownerId) {
  return Workspace.find({ ownerId, isActive: true }).sort({ createdAt: 1 }).select("_id name plan createdAt");
}

async function findAnyWorkspaceForOwner(ownerId) {
  return Workspace.findOne({ ownerId }).sort({ createdAt: 1 }).select("_id name plan isActive createdAt");
}

async function createWorkspace({ ownerId, name }) {
  return Workspace.create({
    ownerId,
    name,
    allowedApiPermissions: {
      campaignSend: true,
      chatAccess: false,
    },
  });
}

async function findActiveWorkspaceById(workspaceId) {
  return Workspace.findOne({ _id: workspaceId, isActive: true }).select(
    "_id ownerId name plan isActive allowedApiPermissions features"
  );
}

async function setExternalChatFeature({ workspaceId, enabled }) {
  const patch = enabled
    ? {
      $set: {
        "features.externalChatApiAccess": true,
        "allowedApiPermissions.chatAccess": true,
      },
    }
    : {
      $set: {
        "features.externalChatApiAccess": false,
      },
    };

  return Workspace.findOneAndUpdate(
    { _id: workspaceId, isActive: true },
    patch,
    { new: true }
  ).select("_id ownerId name plan isActive allowedApiPermissions features");
}

module.exports = {
  listActiveWorkspacesForOwner,
  findAnyWorkspaceForOwner,
  createWorkspace,
  findActiveWorkspaceById,
  setExternalChatFeature,
};

