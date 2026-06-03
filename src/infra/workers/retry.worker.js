const { retryQueue, campaignQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const logger = require("@core/logger/logger");

async function handleRetryJob(job) {
    const payload = job?.data?.payload || {};
    if (payload?.queue === "campaigns") {
        const targetQueue = campaignQueue.getCampaignQueue();
        await targetQueue.add(payload.name || "send-message", payload.data || {}, { delay: payload.delayMs || 0 });
        return { ok: true, requeued: true };
    }
    logger.warn("Retry job skipped", { jobId: job?.id, payload });
    return { ok: true, skipped: true };
}

function startRetryWorker() {
    retryQueue.getRetryQueueScheduler();
    const events = retryQueue.getRetryQueueEvents();
    attachQueueObserver("retry", events);

    const worker = createWorker("retry", handleRetryJob, {
        concurrency: Math.max(Number(process.env.RETRY_WORKER_CONCURRENCY || 5), 1),
    });

    worker.on("failed", (job, err) => {
        logger.warn("Retry job failed", { jobId: job?.id, message: err?.message || String(err) });
    });

    logger.info("Retry worker running");
    return worker;
}

module.exports = { startRetryWorker };

