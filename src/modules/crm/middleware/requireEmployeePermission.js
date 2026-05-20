const { HttpError } = require("@shared/utils/httpError");

function requireEmployeePermission(permissionKey) {
  return (req, res, next) => {
    const key = String(permissionKey || "").trim();
    if (!key) return next();
    const perms = req.employeeDoc?.permissions || req.employee?.permissions || {};
    if (perms && perms[key] === true) return next();
    return next(new HttpError(403, "Permission denied"));
  };
}

module.exports = { requireEmployeePermission };

