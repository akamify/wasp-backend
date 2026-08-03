const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { Subscription } = require("@infra/database/Subscription");
const { Contact } = require("@infra/database/Contact");
const { Template } = require("@infra/database/Template");
const { Campaign } = require("@infra/database/Campaign");
const { Employee } = require("@infra/database/Employee");
const { Flow } = require("@infra/database/Flow");
const { Message } = require("@infra/database/Message");
const { ExternalChatWebhook } = require("@infra/database/ExternalChatWebhook");
const { MediaAsset } = require("@infra/database/MediaAsset");
const { TemplateMedia } = require("@infra/database/TemplateMedia");
const { KnowledgeSource } = require("@infra/database/KnowledgeSource");

async function aggregatePlans(match = { isActive: true }) {
  return Workspace.aggregate([{ $match: match }, { $group: { _id: "$plan", count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
}

async function listSubscriptionsData({ filter, skip, limit }) {
  const activeFilter = { ...filter, isActive: true };
  const [total, workspaces, planSummary] = await Promise.all([
    Workspace.countDocuments(activeFilter),
    Workspace.find(activeFilter)
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("ownerId name plan isActive createdAt updatedAt"),
    aggregatePlans(activeFilter),
  ]);

  const workspaceIds = workspaces.map((w) => w._id);
  const subscriptions = await Subscription.find({ workspaceId: { $in: workspaceIds } })
    .sort({ createdAt: -1 })
    .select("workspaceId planName planSlug status currentPeriodStart currentPeriodEnd durationMonths autoRenewEnabled snapshot paymentMode createdAt updatedAt");

  const latestByWorkspace = new Map();
  for (const s of subscriptions) {
    const key = String(s.workspaceId);
    if (!latestByWorkspace.has(key)) latestByWorkspace.set(key, s);
  }

  return { total, workspaces, planSummary, latestByWorkspace };
}

async function listWorkspaceSubscriptions({ filter }) {
  const workspaceFilter = {
    ...filter,
    isActive: true,
    status: { $ne: "deleted" },
  };

  const workspaces = await Workspace.find(workspaceFilter)
    .sort({ updatedAt: -1 })
    .select("ownerId name plan status isActive aiAgentEnabled aiSubscriptionId createdAt updatedAt");

  const workspaceIds = workspaces.map((workspace) => workspace._id);
  const subscriptions = workspaceIds.length
    ? await Subscription.find({ workspaceId: { $in: workspaceIds } })
        .sort({ createdAt: -1 })
        .select("workspaceId planId planName planSlug status currentPeriodStart currentPeriodEnd durationMonths autoRenewEnabled snapshot paymentMode createdAt updatedAt")
    : [];

  const latestByWorkspace = new Map();
  for (const subscription of subscriptions) {
    const key = String(subscription.workspaceId);
    if (!latestByWorkspace.has(key)) latestByWorkspace.set(key, subscription);
  }

  return { workspaces, latestByWorkspace };
}

async function loadOwnersForWorkspaces(workspaces) {
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  return new Map(owners.map((o) => [String(o._id), o]));
}

async function findWorkspaceById(workspaceId) {
  return Workspace.findById(workspaceId).select("ownerId name plan status isActive aiAgentEnabled aiSubscriptionId createdAt updatedAt");
}

async function findOwnerById(ownerId) {
  return User.findById(ownerId).select("email name");
}

async function countWorkspaceUsage(workspaceId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const [
    contactsCount,
    templatesCount,
    campaignsCount,
    employeesCount,
    flowsCount,
    webhooksCount,
    outboundMessagesTodayCount,
    apiKeyAgg,
    mediaStorageAgg,
    templateMediaAgg,
    knowledgeStorageAgg,
  ] = await Promise.all([
    Contact.countDocuments({ workspaceId }),
    Template.countDocuments({
      workspaceId,
      deletedAt: null,
      isActive: { $ne: false },
      ownerType: { $ne: "system" },
    }),
    Campaign.countDocuments({ workspaceId }),
    Employee.countDocuments({ workspaceId, deletedAt: null }),
    Flow.countDocuments({ workspaceId, deletedAt: null }),
    ExternalChatWebhook.countDocuments({ workspaceId }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      createdAt: { $gte: startOfDay, $lt: endOfDay },
    }),
    User.aggregate([
      { $unwind: "$apiKeys" },
      {
        $match: {
          "apiKeys.workspaceId": workspaceId,
          "apiKeys.revoked": { $ne: true },
          "apiKeys.status": { $ne: "disabled" },
        },
      },
      { $count: "total" },
    ]),
    MediaAsset.aggregate([
      { $match: { workspaceId, deletedAt: null, status: { $ne: "deleted" } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$sizeBytes", 0] } } } },
    ]),
    TemplateMedia.aggregate([
      { $match: { workspaceId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$size", 0] } } } },
    ]),
    KnowledgeSource.aggregate([
      { $match: { workspaceId, deletedAt: null } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$metadata.sizeBytes", 0] } } } },
    ]),
  ]);

  const storageBytes =
    Number(mediaStorageAgg?.[0]?.total || 0) +
    Number(templateMediaAgg?.[0]?.total || 0) +
    Number(knowledgeStorageAgg?.[0]?.total || 0);

  return {
    contactsCount,
    templatesCount,
    campaignsCount,
    employeesCount,
    flowsCount,
    webhooksCount,
    apiKeysCount: Number(apiKeyAgg?.[0]?.total || 0),
    outboundMessagesTodayCount,
    storageBytes,
  };
}

module.exports = {
  aggregatePlans,
  listSubscriptionsData,
  listWorkspaceSubscriptions,
  loadOwnersForWorkspaces,
  findWorkspaceById,
  findOwnerById,
  countWorkspaceUsage,
};
