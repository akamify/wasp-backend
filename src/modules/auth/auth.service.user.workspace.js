const repo = require("@modules/auth/auth.repository");

async function ensureDefaultWorkspace(user) {
  let workspace = await repo.findDefaultWorkspaceForOwner(user._id);
  if (!workspace) {
    workspace = await repo.createWorkspaceForOwner({
      ownerId: user._id,
      name: user.name ? `${String(user.name).trim()}'s workspace` : "My workspace",
    });
  }
  return workspace;
}

module.exports = {
  ensureDefaultWorkspace,
};

