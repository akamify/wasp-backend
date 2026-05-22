module.exports = {
  billingRepository: require("@modules/billing/repositories/billing.repository"),
  planRepository: require("@modules/billing/repositories/plan.repository"),
  subscriptionRepository: require("@modules/billing/repositories/subscription.repository"),
  billingSettingsRepository: require("@modules/billing/repositories/billingSettings.repository"),
  checkoutIntentRepository: require("@modules/billing/repositories/checkoutIntent.repository"),
  processedPaymentEventRepository: require("@modules/billing/repositories/processedPaymentEvent.repository"),
  invoiceRepository: require("@modules/billing/repositories/invoice.repository"),
  invoiceCounterRepository: require("@modules/billing/repositories/invoiceCounter.repository"),
  purchaseLinkRepository: require("@modules/billing/repositories/purchaseLink.repository"),
  featureOverrideRepository: require("@modules/billing/repositories/featureOverride.repository"),
};

