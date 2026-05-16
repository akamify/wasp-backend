const { Workspace } = require("@infra/database/Workspace");
const { User } = require("@infra/database/User");

async function aggregatePlans(match = { isActive: true }) {
  return Workspace.aggregate([{ $match: match }, { $group: { _id: "$plan", count: { $sum: 1 } } }, { $sort: { count: -1 } }]);
}

async function listSubscriptionsData({ filter, skip, limit }) {
  const activeFilter = { ...filter, isActive: true };
  const [total, workspaces, planSummary] = await Promise.all([
    Workspace.countDocuments(activeFilter),
    Workspace.find(activeFilter)
      .sort({ plan: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("ownerId name plan isActive createdAt updatedAt"),
    aggregatePlans(activeFilter),
  ]);
  return { total, workspaces, planSummary };
}

async function loadOwnersForWorkspaces(workspaces) {
  const owners = await User.find({ _id: { $in: workspaces.map((w) => w.ownerId) } }).select("email name");
  return new Map(owners.map((o) => [String(o._id), o]));
}

module.exports = { aggregatePlans, listSubscriptionsData, loadOwnersForWorkspaces };

