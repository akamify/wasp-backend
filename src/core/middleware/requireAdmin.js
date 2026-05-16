const { HttpError } = require("@shared/utils/httpError");

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return next(new HttpError(403, "Admin access required"));
  }
  return next();
}

module.exports = { requireAdmin };
