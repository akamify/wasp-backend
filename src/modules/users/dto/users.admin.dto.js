function mapAdminUserListItem(user, workspace) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name || "",
    phone: user.phone || "",
    role: user.role,
    status: user.status || "active",
    accountBlocked: Boolean(user.accountBlocked),
    createdAt: user.createdAt,
    workspace: workspace ? { id: String(workspace._id), name: workspace.name, plan: workspace.plan, createdAt: workspace.createdAt } : null,
  };
}

function mapAdminUserStatusUser(user) {
  return {
    id: String(user._id),
    email: user.email,
    name: user.name || "",
    role: user.role,
    status: user.status || "active",
    accountBlocked: Boolean(user.accountBlocked),
    createdAt: user.createdAt,
  };
}

module.exports = {
  mapAdminUserListItem,
  mapAdminUserStatusUser,
};

