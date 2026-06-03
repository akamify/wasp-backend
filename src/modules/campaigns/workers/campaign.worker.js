const { campaignQueue, retryQueue, notificationQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const { sendCampaignMessageJob } = require("@modules/campaigns/jobs/sendCampaignMessage.job");
const logger = require("@core/logger/logger");

function startCampaignWorker() {
    const concurrency = Math.max(Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 5), 1);
    const ratePerSec = Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_PER_SEC || 10), 1);

    campaignQueue.getCampaignQueueScheduler();
    const events = campaignQueue.getCampaignQueueEvents();
    attachQueueObserver("campaigns", events);

    const worker = createWorker(
        "campaigns",
        async (job) => sendCampaignMessageJob(job),
        {
            concurrency,
            limiter: { max: ratePerSec, duration: 1000 },
        }
    );

    worker.on("completed", () => { });
    worker.on("failed", async (job, err) => {
        const message = err?.message || String(err);
        logger.warn("Campaign job failed", { jobId: job?.id, message, attemptsMade: job?.attemptsMade });

        const attempts = Number(job?.opts?.attempts || 0);
        const attemptsMade = Number(job?.attemptsMade || 0);
        if (attempts > 0 && attemptsMade >= attempts) {
            try {
                const retry = retryQueue.getRetryQueue();
                await retry.add("campaign-retry", {
                    payload: {
                        queue: "campaigns",
                        name: job?.name || "send-message",
                        data: job?.data || {},
                        delayMs: 0,
                    },
                    reason: message,
                });
            } catch (retryErr) {
                logger.warn("Failed to enqueue retry job", { jobId: job?.id, message: retryErr?.message || String(retryErr) });
            }

            try {
                const notification = notificationQueue.getNotificationQueue();
                await notification.add("campaign-dead-letter", {
                    campaignId: job?.data?.campaignId || null,
                    workspaceId: job?.data?.workspaceId || null,
                    reason: message,
                    failedJobId: job?.id,
                });
            } catch (notifyErr) {
                logger.warn("Failed to enqueue dead-letter notification", {
                    jobId: job?.id,
                    message: notifyErr?.message || String(notifyErr),
                });
            }
        }
    });

    logger.info("Campaign worker running", { concurrency, ratePerSec });
    return worker;
}

module.exports = { startCampaignWorker };

