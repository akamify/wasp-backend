const { HttpError } = require("@shared/utils/httpError");
const { User } = require("@infra/database/User");
const { normalizeAdminPermissions } = require("@shared/utils/adminPermissions");

async function loadAdminPermissions(userId) {
  const user = await User.findById(userId).select("role adminPermissions");
  if (!user) return null;
  const role = String(user.role || "");
  const normalized = normalizeAdminPermissions(role, user.adminPermissions || { pages: [], components: [], actions: [] });
  return { role, ...normalized };
}

function requireAdminPermission(permissionType, permissionKey) {
  return async (req, _res, next) => {
    const role = String(req.user?.role || "");
    if (role === "super_admin") return next();
    if (role !== "admin") return next(new HttpError(403, "Admin access required"));

    const perms = await loadAdminPermissions(req.user?.id);
    if (!perms) return next(new HttpError(401, "Invalid or expired token"));

    const key = String(permissionKey || "").trim();
    const type = String(permissionType || "").trim();
    const source = type === "page" ? perms.pages : type === "action" ? perms.actions : perms.components;
    if (!source.includes(key)) return next(new HttpError(403, `Missing permission: ${key}`));
    return next();
  };
}

module.exports = { requireAdminPermission };
