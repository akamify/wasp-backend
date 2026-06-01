const { requireWorkspacePermission: checkPermission } = require("@modules/workspaces/services/workspacePermission.service");

function requireWorkspacePermission(permissionKey) {
  return async function workspacePermissionMiddleware(req, res, next) {
    try {
      const access = await checkPermission(req.workspace?.id, permissionKey, req.user?.id);
      req.workspaceAccess = access;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireWorkspacePermission };
