const logger = require("@core/logger/logger");
const { processExpiredSubscriptions } = require("@modules/billing/services/billing.lifecycle.service");
const { processAutoRenewReminders } = require("@modules/billing/services/billing.autoRenew.service");

function startSubscriptionLifecycleWorker() {
  const intervalMs = Math.max(Number(process.env.SUBSCRIPTION_LIFECYCLE_INTERVAL_MS || 5 * 60 * 1000), 60 * 1000);

  const run = async () => {
    try {
      const result = await processExpiredSubscriptions({ limit: 100 });
      const renewal = await processAutoRenewReminders({ limit: 100 });
      if (result.processed > 0) {
        logger.info("Subscription lifecycle processed expiries", result);
      }
      if (renewal.processed > 0) {
        logger.info("Subscription auto-renew reminders processed", renewal);
      }
    } catch (err) {
      logger.warn("Subscription lifecycle worker failed", { message: err?.message || String(err) });
    }
  };

  run();
  const timer = setInterval(run, intervalMs);
  logger.info("Subscription lifecycle worker running", { intervalMs });
  return { stop: () => clearInterval(timer) };
}

module.exports = { startSubscriptionLifecycleWorker };
