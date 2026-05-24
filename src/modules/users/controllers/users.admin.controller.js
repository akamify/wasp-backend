const usersService = require("@modules/users/services/users.admin.service");

async function adminListUsers(req, res) {
  const result = await usersService.listUsers(req);
  return res.json(result);
}

async function adminUpdateUserStatus(req, res) {
  const result = await usersService.updateUserStatus(req);
  if (result?.statusCode) return res.status(result.statusCode).json(result.body);
  return res.json(result);
}

module.exports = {
  adminListUsers,
  adminUpdateUserStatus,
};

