const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { HttpError } = require("@shared/utils/httpError");
const { ROLE_PERMISSIONS, WORKSPACE_PERMISSIONS } = require("@modules/workspaces/constants/workspacePermissions");

function applyOverrides(basePermissions, overrides = {}) {
  const result = new Set(basePermissions);
  for (const [key, enabled] of Object.entries(overrides || {})) {
    if (!WORKSPACE_PERMISSIONS.includes(key)) continue;
    if (enabled) result.add(key);
    else result.delete(key);
  }
  return [...result];
}

async function ensureOwnerMembership(workspace) {
  const ownerUserId = workspace.ownerUserId || workspace.ownerId;
  if (!ownerUserId) return null;
  return WorkspaceMember.findOneAndUpdate(
    { workspaceId: workspace._id, userId: ownerUserId },
    {
      $setOnInsert: {
        workspaceId: workspace._id,
        userId: ownerUserId,
        joinedAt: workspace.createdAt || new Date(),
      },
      $set: { role: "owner", status: "active" },
    },
    { upsert: true, new: true }
  );
}

async function resolveWorkspaceAccess({ workspaceId, userId }) {
  if (!workspaceId || !userId) return null;
  const workspace = await Workspace.findOne({
    _id: workspaceId,
    isActive: true,
    status: { $ne: "deleted" },
  });
  if (!workspace) return null;

  let membership = await WorkspaceMember.findOne({
    workspaceId: workspace._id,
    userId,
    status: "active",
  });
  if (!membership && String(workspace.ownerUserId || workspace.ownerId) === String(userId)) {
    membership = await ensureOwnerMembership(workspace);
  }
  if (!membership) return null;

  const role = membership.role || "viewer";
  return {
    workspace,
    membership,
    role,
    permissions: applyOverrides(ROLE_PERMISSIONS[role] || [], membership.permissionsOverride),
  };
}

async function requireWorkspacePermission(workspaceId, permissionKey, userId) {
  const access = await resolveWorkspaceAccess({ workspaceId, userId });
  if (!access) throw new HttpError(404, "Workspace not found");
  if (access.role !== "owner" && !access.permissions.includes(permissionKey)) {
    throw new HttpError(403, "Workspace permission denied", { permission: permissionKey });
  }
  return access;
}

module.exports = {
  ensureOwnerMembership,
  requireWorkspacePermission,
  resolveWorkspaceAccess,
};
