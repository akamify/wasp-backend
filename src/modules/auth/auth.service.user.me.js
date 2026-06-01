const { HttpError } = require("@shared/utils/httpError");
const repo = require("@modules/auth/auth.repository");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");
const { normalizeAdminPermissions } = require("@shared/utils/adminPermissions");

async function me({ authUser, selectedWorkspaceId }) {
  const user = await repo.findUserForMe(authUser.id);
  if (!user) throw new HttpError(404, "User not found");

  const requestedWorkspaceId = selectedWorkspaceId || authUser.workspaceId;
  let workspace = requestedWorkspaceId
    ? await repo.findWorkspaceForUserAndId({ workspaceId: requestedWorkspaceId, ownerId: authUser.id })
    : null;

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

