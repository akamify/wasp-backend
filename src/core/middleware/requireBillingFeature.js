const { subscriptionRepository } = require("@modules/billing/repositories");
const { HttpError } = require("@shared/utils/httpError");
const { getFreePlanConfig } = require("@modules/billing/services/freePlan.service");

function resolveFeatureValue(subscription, freeFeatures, featureKey) {
  if (!subscription) return Boolean((freeFeatures || {})[featureKey]);
  return Boolean(subscription?.snapshot?.features?.[featureKey]);
}

function requireBillingFeature(featureKey, options = {}) {
  const { message = "Upgrade plan to access this feature." } = options;
  return async function billingFeatureMiddleware(req, _res, next) {
    try {
      if (!req.workspace?.id) return next(new HttpError(400, "Missing workspace context"));
      const subscription = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
      const freeConfig = subscription ? null : await getFreePlanConfig();
      const allowed = resolveFeatureValue(subscription, freeConfig?.features, featureKey);
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
