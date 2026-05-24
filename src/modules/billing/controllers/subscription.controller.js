const subscriptionService = require("@modules/billing/services/subscription.service");

async function getCurrentSubscription(req, res) {
  res.json(await subscriptionService.currentSubscription(req));
}

async function getSubscriptionHistory(req, res) {
  res.json(await subscriptionService.subscriptionHistory(req));
}

module.exports = { getCurrentSubscription, getSubscriptionHistory };
