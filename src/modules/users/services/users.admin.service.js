const mongoose = require("mongoose");
const { usersRepository } = require("@modules/users/repositories/index");
const { usersAdminValidation } = require("@modules/users/validations/index");
const { listResponse } = require("@modules/users/utils/listResponse");
const { mapAdminUserListItem, mapAdminUserStatusUser } = require("@modules/users/dto/users.admin.dto");

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

async function listUsers(req) {
  const { page, limit, skip, rx, filterKey, sortKey, includeTest } = usersAdminValidation.parseListUsersQuery(req);

  const searchFilter = rx
    ? {
        $or: [{ email: rx }, { name: rx }, { phone: rx }, { role: rx }],
      }
    : {};

  const roleFilter =
    filterKey === "admin" ? { role: "admin" } : filterKey === "member" ? { role: "user" } : {};

  // Back-compat: older DBs won't have `status`. Treat missing as active.
  const statusFilter =
    filterKey === "blocked"
      ? { accountBlocked: true }
      : filterKey === "banned"
      ? { status: "banned" }
      : filterKey === "all"
        ? {}
        : { $or: [{ status: { $exists: false } }, { status: "active" }] };

  const baseFilter = includeTest
    ? searchFilter
    : {
        $and: [searchFilter, { $nor: usersAdminValidation.testDataNorFilter() }],
      };

  const filter = { $and: [baseFilter, roleFilter, statusFilter] };
  const sort =
    sortKey === "old"
      ? { createdAt: 1 }
      : sortKey === "az"
        ? { name: 1, email: 1 }
        : { createdAt: -1 };

  const { total, users } = await usersRepository.adminFindUsers({ filter, sort, skip, limit });
  const workspaces = await usersRepository.adminFindActiveWorkspacesForOwners(users.map((u) => u._id));
  const workspaceByOwnerId = new Map(workspaces.map((w) => [String(w.ownerId), w]));

  return listResponse({
    items: users.map((u) => mapAdminUserListItem(u, workspaceByOwnerId.get(String(u._id)))),
    total,
    page,
    limit,
  });
}

async function updateUserStatus(req) {
  const id = String(req.params.id || "").trim();
  if (!isValidObjectId(id)) return { statusCode: 400, body: { success: false, message: "Invalid user id" } };

  const status = String(req.body?.status || "").trim().toLowerCase();
  if (!["active", "banned"].includes(status)) {
    return { statusCode: 400, body: { success: false, message: "Invalid status" } };
  }

  const user = await usersRepository.adminUpdateUserStatus({ id, status });
  if (!user) return { statusCode: 404, body: { success: false, message: "User not found" } };

  return { success: true, user: mapAdminUserStatusUser(user) };
}

module.exports = {
  listUsers,
  updateUserStatus,
};

