const campaignQueue = require("@infra/queues/campaign.queue");
const retryQueue = require("@infra/queues/retry.queue");
const notificationQueue = require("@infra/queues/notification.queue");
const webhookQueue = require("@infra/queues/webhook.queue");
const crmLeadAssignmentQueue = require("@infra/queues/crmLeadAssignment.queue");
const crmAnalyticsQueue = require("@infra/queues/crmAnalytics.queue");
const crmExportQueue = require("@infra/queues/crmExport.queue");
const flowSessionExpiryQueue = require("@infra/queues/flowSessionExpiry.queue");

async function closeAllQueueResources() {
    await Promise.allSettled([
        campaignQueue.closeCampaignQueueResources(),
        retryQueue.closeRetryQueueResources(),
        notificationQueue.closeNotificationQueueResources(),
        webhookQueue.closeWebhookQueueResources(),
        crmLeadAssignmentQueue.closeCrmLeadAssignmentQueueResources(),
        crmAnalyticsQueue.closeCrmAnalyticsQueueResources(),
        crmExportQueue.closeCrmExportQueueResources(),
        flowSessionExpiryQueue.closeFlowSessionExpiryQueueResources(),
    ]);
}

module.exports = {
    campaignQueue,
    retryQueue,
    notificationQueue,
    webhookQueue,
    crmLeadAssignmentQueue,
    crmAnalyticsQueue,
    crmExportQueue,
    flowSessionExpiryQueue,
    closeAllQueueResources,
    queueNames: require("@infra/queues/queueNames"),
    queueFactory: require("@infra/queues/queueFactory"),
    queueObserver: require("@infra/queues/queueObserver"),
};
