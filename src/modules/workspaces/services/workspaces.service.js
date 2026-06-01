const { HttpError } = require("@shared/utils/httpError");
const { workspacesRepository } = require("@modules/workspaces/repositories/index");
const { mapWorkspaceListItem, mapWorkspaceCreated } = require("@modules/workspaces/dto/workspaces.dto");
const { emitWorkspaceCreated } = require("@modules/workspaces/events/index");
const { Workspace } = require("@infra/database/Workspace");
const { ensureOwnerMembership, requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { serializeWhatsAppConnection } = require("@shared/services/whatsappConnectionMetadataService");

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function listWorkspaces({ ownerId }) {
  const owned = await Workspace.find({ ownerId, isActive: true, status: { $ne: "deleted" } });
  await Promise.all(owned.map(ensureOwnerMembership));
  const memberships = await workspacesRepository.listActiveMembershipsForUser(ownerId);
  return {
    success: true,
    workspaces: memberships
      .filter((item) => item.workspaceId)
      .map((item) => ({ ...mapWorkspaceListItem(item.workspaceId), role: item.role })),
  };
}

async function createWorkspace({ ownerId, payload }) {
  const { name, businessName, defaultCurrency, timezone, industry } = payload || {};
  const normalized = String(name || "").trim();
  if (!normalized) throw new HttpError(400, "Workspace name is required");
  const slugBase = slugify(payload?.slug || normalized) || `workspace-${Date.now().toString(36)}`;
  let slug = slugBase;
  for (let suffix = 1; await Workspace.exists({ slug }); suffix += 1) slug = `${slugBase}-${suffix}`;
  const workspace = await workspacesRepository.createWorkspace({
    ownerId,
    name: normalized,
    slug,
    businessName,
    defaultCurrency,
    timezone,
    industry,
  });

  // Non-breaking: emitting events has no side effects unless listeners are added.
  emitWorkspaceCreated({ workspaceId: String(workspace._id), ownerId: String(ownerId) });

  return { success: true, workspace: mapWorkspaceCreated(workspace) };
}

async function getWorkspaceOverview({ workspaceId, userId }) {
  const access = await requireWorkspacePermission(workspaceId, "workspace.view", userId);
  const data = await workspacesRepository.getWorkspaceOverviewData(workspaceId);
  return {
    success: true,
    workspace: mapWorkspaceListItem(data.workspace),
    role: access.role,
    permissions: access.permissions,
    subscription: data.subscription,
    plan: data.plan,
    entitlements: data.subscription?.snapshot || { features: {}, limits: {} },
    usage: data.counts,
    wallet: data.wallet || { workspaceId, balance: 0, currency: data.workspace?.defaultCurrency || "INR" },
    whatsappConnection: serializeWhatsAppConnection(data.whatsappConnection),
    counts: data.counts,
    recentActivity: data.recentActivity,
  };
}

async function updateWorkspace({ workspaceId, userId, payload }) {
  await requireWorkspacePermission(workspaceId, "workspace.update", userId);
  const patch = {};
  for (const key of ["name", "businessName", "defaultCurrency", "timezone", "industry", "logoUrl", "avatarUrl"]) {
    if (payload?.[key] !== undefined) patch[key] = payload[key] || null;
  }
  const workspace = await workspacesRepository.updateWorkspace({ workspaceId, patch, actorUserId: userId });
  if (!workspace) throw new HttpError(404, "Workspace not found");
  return { success: true, workspace: mapWorkspaceListItem(workspace) };
}

async function listMembers({ workspaceId, userId }) {
  await requireWorkspacePermission(workspaceId, "members.view", userId);
  return { success: true, members: await workspacesRepository.listWorkspaceMembers(workspaceId) };
}

async function listUsage({ workspaceId, userId }) {
  await requireWorkspacePermission(workspaceId, "workspace.view", userId);
  return { success: true, usage: await workspacesRepository.listWorkspaceUsage(workspaceId) };
}

async function listActivity({ workspaceId, userId }) {
  await requireWorkspacePermission(workspaceId, "workspace.view", userId);
  return { success: true, activity: await workspacesRepository.listWorkspaceActivity(workspaceId) };
}

async function inviteMember({ workspaceId, userId, payload }) {
  await requireWorkspacePermission(workspaceId, "members.invite", userId);
  const invitee = await workspacesRepository.findUserByEmail(payload?.email);
  if (!invitee) throw new HttpError(404, "User account not found for invitation");
  const member = await workspacesRepository.inviteWorkspaceMember({
    workspaceId,
    userId: invitee._id,
    role: payload.role || "viewer",
    invitedBy: userId,
  });
  return { success: true, member };
}

async function updateMember({ workspaceId, memberId, userId, payload }) {
  await requireWorkspacePermission(workspaceId, "members.manage", userId);
  const patch = {};
  if (payload.role) patch.role = payload.role;
  if (payload.status) patch.status = payload.status;
  if (payload.permissionsOverride) patch.permissionsOverride = payload.permissionsOverride;
  if (payload.status === "active") patch.joinedAt = new Date();
  const member = await workspacesRepository.updateWorkspaceMember({ workspaceId, memberId, patch, actorUserId: userId });
  if (!member) throw new HttpError(404, "Workspace member not found or owner cannot be modified");
  return { success: true, member };
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
