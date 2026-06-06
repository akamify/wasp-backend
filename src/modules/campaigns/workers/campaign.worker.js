const { campaignQueue, notificationQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const { CAMPAIGN_QUEUE_JOBS } = require("@modules/campaigns/constants/campaign.constants");
const { sendCampaignMessageJob } = require("@modules/campaigns/jobs/sendCampaignMessage.job");
const {
    dispatchScheduledCampaign,
    recoverScheduledCampaignDispatches,
    reconcileDueCampaignSchedules,
} = require("@modules/campaigns/services/campaignScheduler.service");
const logger = require("@core/logger/logger");

function startCampaignWorker() {
    const concurrency = Math.max(Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 5), 1);
    const ratePerSec = Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_PER_SEC || 10), 1);

    campaignQueue.getCampaignQueueScheduler();
    const events = campaignQueue.getCampaignQueueEvents();
    attachQueueObserver("campaigns", events);

    const worker = createWorker(
        "campaigns",
        async (job) => {
            if (job.name === CAMPAIGN_QUEUE_JOBS.DISPATCH_SCHEDULED) {
                return dispatchScheduledCampaign(job.data || {});
            }
            return sendCampaignMessageJob(job);
        },
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

    recoverScheduledCampaignDispatches()
        .then((result) => logger.info("Campaign schedule recovery completed", result))
        .catch((err) => logger.warn("Campaign schedule recovery failed", { message: err?.message || String(err) }));

    let reconcileRunning = false;
    const reconcileInterval = setInterval(async () => {
        if (reconcileRunning) return;
        reconcileRunning = true;
        try {
            await reconcileDueCampaignSchedules();
        } catch (err) {
            logger.warn("Campaign schedule reconciler failed", { message: err?.message || String(err) });
        } finally {
            reconcileRunning = false;
        }
    }, 60 * 1000);
    reconcileInterval.unref?.();

    logger.info("Campaign worker started", { concurrency, ratePerSec });
    logger.info("Campaign schedule reconciler started", { intervalMs: 60 * 1000 });
    return {
        async close() {
            clearInterval(reconcileInterval);
            await worker.close();
        },
    };
}

module.exports = { startCampaignWorker };

