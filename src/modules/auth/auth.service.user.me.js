const { HttpError } = require("@shared/utils/httpError");
const { adminEmail, adminName } = require("@core/config/env");
const { Workspace } = require("@infra/database/Workspace");
const repo = require("@modules/auth/auth.repository");
const { ensureDefaultWorkspace } = require("@modules/auth/auth.service.user.workspace");
const adminService = require("@modules/auth/auth.service.admin");

async function me({ authUser }) {
  if (authUser.role === "admin" && authUser.id === "env-admin") {
    return {
      success: true,
      user: { id: "env-admin", email: adminEmail, name: adminName, role: "admin" },
      workspace: null,
    };
  }

  if (authUser.role === "admin") {
    return adminService.adminMe(authUser.id);
  }

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
      createdAt: user.createdAt,
      twoFactorEnabled: !!user.twoFactorEnabled,
    },
    workspace: workspace ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan } : null,
  };
}

module.exports = {
  me,
};

