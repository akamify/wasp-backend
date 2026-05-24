const { HttpError } = require("@shared/utils/httpError");
const { Workspace } = require("@infra/database/Workspace");
const repo = require("@modules/auth/auth.repository");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");
const { normalizeAdminPermissions } = require("@shared/utils/adminPermissions");

async function me({ authUser }) {
  const user = await repo.findUserForMe(authUser.id);
  if (!user) throw new HttpError(404, "User not found");

  let workspace = await Workspace.findOne({
    _id: authUser.workspaceId,
    ownerId: authUser.id,
    isActive: true,
  }).select("_id name plan");

  if (!workspace) {
    workspace = await ensureDefaultWorkspace(user);
  }

  return {
    success: true,
    user: {
      id: String(user._id),
      email: user.email,
      name: user.name,
      phone: user.phone,
      role: user.role,
      permissions: normalizeAdminPermissions(user.role, user.adminPermissions || { pages: [], components: [], actions: [] }),
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    workspace: workspace ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan } : null,
  };
}

module.exports = {
  me,
};

