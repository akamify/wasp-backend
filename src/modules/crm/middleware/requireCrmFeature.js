const { HttpError } = require("@shared/utils/httpError");

function requireCrmFeature(feature) {
  return (req, res, next) => {
    const key = String(feature || "crm").trim().toLowerCase();
    if (key === "crm") {
      if (!req.workspace?.crmEnabled) return next(new HttpError(403, "CRM is disabled for this workspace"));
      return next();
    }

    // Placeholder: future feature gates can be layered on top of plan/overrides.
    if (!req.workspace?.crmEnabled) return next(new HttpError(403, "CRM is disabled for this workspace"));
    return next();
  };
}

module.exports = { requireCrmFeature };

