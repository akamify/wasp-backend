const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");
const { Subscription } = require("@infra/database/Subscription");
const { Contact } = require("@infra/database/Contact");
const { Template } = require("@infra/database/Template");
const { Campaign } = require("@infra/database/Campaign");
const { Employee } = require("@infra/database/Employee");

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

async function loadOwnersForWorkspaces(workspaces) {
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  return new Map(owners.map((o) => [String(o._id), o]));
}

async function findWorkspaceById(workspaceId) {
  return Workspace.findById(workspaceId).select("ownerId name plan isActive createdAt updatedAt");
}

async function findOwnerById(ownerId) {
  return User.findById(ownerId).select("email name");
}

async function countWorkspaceUsage(workspaceId) {
  const [contactsCount, templatesCount, campaignsCount, employeesCount] = await Promise.all([
    Contact.countDocuments({ workspaceId }),
    Template.countDocuments({ workspaceId }),
    Campaign.countDocuments({ workspaceId }),
    Employee.countDocuments({ workspaceId, deletedAt: null }),
  ]);

  return { contactsCount, templatesCount, campaignsCount, employeesCount };
}

module.exports = {
  aggregatePlans,
  listSubscriptionsData,
  loadOwnersForWorkspaces,
  findWorkspaceById,
  findOwnerById,
  countWorkspaceUsage,
};
