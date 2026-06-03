const { campaignQueue, retryQueue, notificationQueue, webhookQueue } = require("@infra/queues/index");
const logger = require("@core/logger/logger");

function startCleanupWorker() {
    const intervalMs = Math.max(Number(process.env.QUEUE_CLEANUP_INTERVAL_MS || 60_000), 10_000);
    const graceMs = Math.max(Number(process.env.QUEUE_CLEANUP_GRACE_MS || 60 * 60 * 1000), 10_000);

    const queues = [
        campaignQueue.getCampaignQueue(),
        retryQueue.getRetryQueue(),
        notificationQueue.getNotificationQueue(),
        webhookQueue.getWebhookQueue(),
    ];

    const timer = setInterval(async () => {
        for (const queue of queues) {
            try {
                await queue.clean(graceMs, 1000, "completed");
                await queue.clean(graceMs, 1000, "failed");
            } catch (err) {
                logger.warn("Queue cleanup failed", { queue: queue?.name, message: err?.message || String(err) });
            }
        }
    }, intervalMs);

    logger.info("Cleanup worker running", { intervalMs, graceMs });
    return { stop: () => clearInterval(timer) };
}

module.exports = { startCleanupWorker };

