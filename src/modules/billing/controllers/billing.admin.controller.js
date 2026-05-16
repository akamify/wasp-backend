const billingService = require("@modules/billing/services/billing.admin.service");

async function adminSubscriptionPlans(req, res) {
  res.json(await billingService.subscriptionPlans());
}

async function adminSubscriptionsData(req, res) {
  res.json(await billingService.subscriptionsData(req));
}

async function adminPaymentGateway(req, res) {
  res.json(await billingService.paymentGateway(req));
}

module.exports = { adminSubscriptionPlans, adminSubscriptionsData, adminPaymentGateway };

