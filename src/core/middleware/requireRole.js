const { HttpError } = require("@shared/utils/httpError");

function requireRole(...roles) {
  const allowed = Array.isArray(roles) ? roles.filter(Boolean) : [];
  return (req, res, next) => {
    const role = String(req.user?.role || "");
    if (!allowed.includes(role)) {
      return next(new HttpError(403, "Insufficient role permission"));
    }
    return next();
  };
}

function requireSuperAdmin(req, res, next) {
  return requireRole("super_admin")(req, res, next);
}

module.exports = {
  requireRole,
  requireSuperAdmin,
};
