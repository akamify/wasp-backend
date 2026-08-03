const { HttpError } = require("@shared/utils/httpError");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");
const { getWorkspaceEntitlements } = require("@modules/workspaces/services/workspaceEntitlement.service");

function requireBillingFeature(featureKey, options = {}) {
  const { message = "Upgrade plan to access this feature." } = options;
  return async function billingFeatureMiddleware(req, _res, next) {
    try {
      if (!isPlanRestrictionsEnabled()) return next();
      if (!req.workspace?.id) return next(new HttpError(400, "Missing workspace context"));
      if (String(req.workspace?.status || "active") !== "active") {
        return next(new HttpError(403, "Workspace is blocked", { featureKey, code: "WORKSPACE_BLOCKED" }));
      }
      const entitlements = await getWorkspaceEntitlements(req.workspace.id);
      const allowed = Boolean(entitlements.features?.[featureKey]);
      if (!allowed) {
        return next(new HttpError(403, message, { featureKey, code: "FEATURE_NOT_ALLOWED" }));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireBillingFeature };
