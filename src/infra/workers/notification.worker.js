const { notificationQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const { logger } = require("@core/logger/logger");

async function handleNotificationJob(job) {
    logger.info("Notification job received", { jobId: job?.id, data: job?.data || {} });
    return { ok: true };
}

function startNotificationWorker() {
    notificationQueue.getNotificationQueueScheduler();
    const events = notificationQueue.getNotificationQueueEvents();
    attachQueueObserver("notification", events);

    const worker = createWorker("notification", handleNotificationJob, {
        concurrency: Math.max(Number(process.env.NOTIFICATION_WORKER_CONCURRENCY || 2), 1),
    });

    worker.on("failed", (job, err) => {
        logger.warn("Notification job failed", { jobId: job?.id, message: err?.message || String(err) });
    });

    logger.info("Notification worker running");
    return worker;
}

module.exports = { startNotificationWorker };

