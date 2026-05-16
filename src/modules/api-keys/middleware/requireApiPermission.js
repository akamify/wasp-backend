const { HttpError } = require("@shared/utils/httpError");

function requireApiPermission(permission) {
  return (req, res, next) => {
    if (!req.auth?.isApiKey) return next();
    if (!permission) return next();
    const allowed = Boolean(req.auth?.permissions?.[permission]);
    if (!allowed) return next(new HttpError(403, `API key missing permission: ${permission}`));
    return next();
  };
}

module.exports = { requireApiPermission };
