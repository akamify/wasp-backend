const { subscriptionRepository } = require("@modules/billing/repositories");
const { HttpError } = require("@shared/utils/httpError");

const FREE_FEATURES = Object.freeze({
  dashboardPageAccess: true,
  templatesPageAccess: true,
  campaignsPageAccess: true,
  contactsPageAccess: true,
  inboxPageAccess: true,
  walletPageAccess: true,
  crmPageAccess: false,
  flowsPageAccess: false,
  linksPageAccess: false,
  automationPageAccess: false,
  activityPageAccess: false,
  apiKeysPageAccess: false,
  apiReportsPageAccess: false,
  campaignApiAccess: false,
  exportAccess: true,
  analyticsAccess: false,
  employeeAccess: false,
  leadDistributionAccess: false,
  automationAccess: false,
  apiKeyAccess: false,
  externalChatApiAccess: false,
  crmAccess: false,
});

function resolveFeatureValue(subscription, featureKey) {
  if (!subscription) return Boolean(FREE_FEATURES[featureKey]);
  return Boolean(subscription?.snapshot?.features?.[featureKey]);
}

function requireBillingFeature(featureKey, options = {}) {
  const { message = "Upgrade plan to access this feature." } = options;
  return async function billingFeatureMiddleware(req, _res, next) {
    try {
      if (!req.workspace?.id) return next(new HttpError(400, "Missing workspace context"));
      const subscription = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
      const allowed = resolveFeatureValue(subscription, featureKey);
      if (!allowed) {
        return next(new HttpError(403, message, { featureKey, code: "FEATURE_NOT_ALLOWED" }));
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireBillingFeature, FREE_FEATURES };

