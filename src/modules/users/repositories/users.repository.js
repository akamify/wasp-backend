const { User } = require("@infra/database/User");
const { Workspace } = require("@infra/database/Workspace");

async function adminFindUsers({ filter, sort, skip, limit }) {
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort(sort).skip(skip).limit(limit).select("email name phone role status accountBlocked createdAt"),
  ]);
  return { total, users };
}

async function adminFindActiveWorkspacesForOwners(ownerIds) {
  return Workspace.find({ ownerId: { $in: ownerIds }, isActive: true }).select("ownerId name plan createdAt");
}

async function adminUpdateUserStatus({ id, status }) {
  return User.findByIdAndUpdate(id, { $set: { status } }, { new: true }).select("email name role status createdAt");
}

module.exports = {
  adminFindUsers,
  adminFindActiveWorkspacesForOwners,
  adminUpdateUserStatus,
};
