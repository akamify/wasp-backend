const { HttpError } = require("@shared/utils/httpError");

function requireAdmin(req, res, next) {
  if (!["admin", "super_admin"].includes(String(req.user?.role || ""))) {
    return next(new HttpError(403, "Admin access required"));
  }
  return next();
}

module.exports = { requireAdmin };
