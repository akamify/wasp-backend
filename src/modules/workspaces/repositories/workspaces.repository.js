const { Workspace } = require("@infra/database/Workspace");
const { WorkspaceMember } = require("@infra/database/WorkspaceMember");
const { WorkspaceActivityLog } = require("@infra/database/WorkspaceActivityLog");
const { WorkspaceUsageMonthly } = require("@infra/database/WorkspaceUsageMonthly");
const { Subscription } = require("@infra/database/Subscription");
const { Plan } = require("@infra/database/Plan");
const { Wallet } = require("@infra/database/Wallet");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { Contact } = require("@infra/database/Contact");
const { Conversation } = require("@infra/database/Conversation");
const { Template } = require("@infra/database/Template");
const { Campaign } = require("@infra/database/Campaign");
const { Message } = require("@infra/database/Message");
const { User } = require("@infra/database/User");

async function listActiveMembershipsForUser(userId) {
  return WorkspaceMember.find({ userId, status: "active" }).sort({ joinedAt: 1, createdAt: 1 }).populate({
    path: "workspaceId",
    match: { isActive: true, status: { $ne: "deleted" } },
    select: "_id name slug businessName plan status createdAt defaultCurrency timezone",
  });
}

async function findAnyWorkspaceForOwner(ownerId) {
  return Workspace.findOne({ ownerId }).sort({ createdAt: 1 }).select("_id name plan isActive createdAt");
}

async function createWorkspace({ ownerId, name, slug, businessName, defaultCurrency, timezone, industry }) {
  const workspace = await Workspace.create({
    ownerId,
    ownerUserId: ownerId,
    name,
    slug,
    businessName: businessName || null,
    defaultCurrency: defaultCurrency || "INR",
    timezone: timezone || "Asia/Calcutta",
    industry: industry || null,
    allowedApiPermissions: {
      campaignSend: true,
      chatAccess: false,
    },
  });
  await WorkspaceMember.create({
    workspaceId: workspace._id,
    userId: ownerId,
    role: "owner",
    status: "active",
    joinedAt: new Date(),
  });
  await WorkspaceActivityLog.create({
    workspaceId: workspace._id,
    actorUserId: ownerId,
    action: "workspace.created",
    entityType: "workspace",
    entityId: String(workspace._id),
  });
  return workspace;
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

async function updateWorkspace({ workspaceId, patch, actorUserId }) {
  const workspace = await Workspace.findOneAndUpdate(
    { _id: workspaceId, isActive: true, status: { $ne: "deleted" } },
    { $set: patch },
    { new: true }
  );
  if (workspace) {
    await WorkspaceActivityLog.create({
      workspaceId,
      actorUserId,
      action: "workspace.updated",
      entityType: "workspace",
      entityId: String(workspaceId),
      metadata: { fields: Object.keys(patch) },
    });
  }
  return workspace;
}

async function getWorkspaceOverviewData(workspaceId) {
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);
  const [workspace, subscription, wallet, whatsappConnection, members, contactsCount, conversationsCount, templatesCount, campaignsSentThisMonth, messagesSentThisMonth, recentActivity] =
    await Promise.all([
      Workspace.findById(workspaceId),
      Subscription.findOne({ workspaceId }).sort({ createdAt: -1 }),
      Wallet.findOne({ workspaceId }),
      WhatsAppCredentials.findOne({ workspaceId, isActive: { $ne: false } }).sort({ connectedAt: -1 }),
      WorkspaceMember.find({ workspaceId, status: "active" }).sort({ createdAt: 1 }),
      Contact.countDocuments({ workspaceId }),
      Conversation.countDocuments({ workspaceId }),
      Template.countDocuments({ workspaceId, isActive: { $ne: false }, deletedAt: null }),
      Campaign.countDocuments({ workspaceId, createdAt: { $gte: startOfMonth }, status: { $in: ["queued", "running", "completed"] } }),
      Message.countDocuments({ workspaceId, createdAt: { $gte: startOfMonth }, direction: "outbound" }),
      WorkspaceActivityLog.find({ workspaceId }).sort({ createdAt: -1 }).limit(20),
    ]);
  const plan = subscription?.planId ? await Plan.findById(subscription.planId) : null;
  const period = new Date().toISOString().slice(0, 7);
  await WorkspaceUsageMonthly.findOneAndUpdate(
    { workspaceId, period },
    {
      $set: {
        contactsCount,
        campaignsSent: campaignsSentThisMonth,
        messagesSent: messagesSentThisMonth,
        templatesCount,
        agentsCount: members.length,
      },
    },
    { upsert: true, new: true }
  );
  return {
    workspace,
    subscription,
    plan,
    wallet,
    whatsappConnection,
    members,
    counts: {
      contacts: contactsCount,
      conversations: conversationsCount,
      templates: templatesCount,
      campaignsSentThisMonth,
      messagesSentThisMonth,
      teamMembers: members.length,
    },
    recentActivity,
  };
}

async function listWorkspaceMembers(workspaceId) {
  return WorkspaceMember.find({ workspaceId, status: { $ne: "removed" } })
    .sort({ createdAt: 1 })
    .populate("userId", "name email phone");
}

async function listWorkspaceActivity(workspaceId, limit = 50) {
  return WorkspaceActivityLog.find({ workspaceId }).sort({ createdAt: -1 }).limit(limit);
}

async function listWorkspaceUsage(workspaceId) {
  return WorkspaceUsageMonthly.find({ workspaceId }).sort({ period: -1 }).limit(24);
}

async function findUserByEmail(email) {
  return User.findOne({ email: String(email || "").trim().toLowerCase() }).select("_id name email");
}

async function inviteWorkspaceMember({ workspaceId, userId, role, invitedBy }) {
  const member = await WorkspaceMember.findOneAndUpdate(
    { workspaceId, userId },
    {
      $set: { role, status: "invited", invitedBy },
      $setOnInsert: { joinedAt: null },
    },
    { upsert: true, new: true }
  );
  await WorkspaceActivityLog.create({
    workspaceId,
    actorUserId: invitedBy,
    action: "member.invited",
    entityType: "workspace_member",
    entityId: String(member._id),
    metadata: { userId: String(userId), role },
  });
  return member;
}

async function updateWorkspaceMember({ workspaceId, memberId, patch, actorUserId }) {
  const member = await WorkspaceMember.findOneAndUpdate(
    { _id: memberId, workspaceId, role: { $ne: "owner" } },
    { $set: patch },
    { new: true }
  );
  if (member) {
    await WorkspaceActivityLog.create({
      workspaceId,
      actorUserId,
      action: "member.updated",
      entityType: "workspace_member",
      entityId: String(member._id),
      metadata: patch,
    });
  }
  return member;
}

module.exports = {
  listActiveMembershipsForUser,
  findAnyWorkspaceForOwner,
  createWorkspace,
  findActiveWorkspaceById,
  setExternalChatFeature,
  updateWorkspace,
  getWorkspaceOverviewData,
  listWorkspaceMembers,
  listWorkspaceActivity,
  listWorkspaceUsage,
  findUserByEmail,
  inviteWorkspaceMember,
  updateWorkspaceMember,
};

