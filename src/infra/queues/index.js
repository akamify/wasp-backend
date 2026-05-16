const campaignQueue = require("@infra/queues/campaign.queue");
const retryQueue = require("@infra/queues/retry.queue");
const notificationQueue = require("@infra/queues/notification.queue");
const webhookQueue = require("@infra/queues/webhook.queue");

async function closeAllQueueResources() {
    await Promise.allSettled([
        campaignQueue.closeCampaignQueueResources(),
        retryQueue.closeRetryQueueResources(),
        notificationQueue.closeNotificationQueueResources(),
        webhookQueue.closeWebhookQueueResources(),
    ]);
}

module.exports = {
    campaignQueue,
    retryQueue,
    notificationQueue,
    webhookQueue,
    closeAllQueueResources,
    queueNames: require("@infra/queues/queueNames"),
    queueFactory: require("@infra/queues/queueFactory"),
    queueObserver: require("@infra/queues/queueObserver"),
};
