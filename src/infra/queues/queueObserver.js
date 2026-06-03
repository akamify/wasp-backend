const logger = require("@core/logger/logger");

function attachQueueObserver(queueName, queueEvents) {
    const log = logger.child({ scope: "queue", queue: queueName });
    queueEvents.on("completed", ({ jobId, returnvalue }) => {
        log.info("Job completed", { jobId, returnvalue });
    });
    queueEvents.on("failed", ({ jobId, failedReason, prev }) => {
        log.warn("Job failed", { jobId, failedReason, prev });
    });
    queueEvents.on("stalled", ({ jobId }) => {
        log.warn("Job stalled", { jobId });
    });
    queueEvents.on("waiting", ({ jobId }) => {
        log.debug("Job waiting", { jobId });
    });
    queueEvents.on("active", ({ jobId }) => {
        log.debug("Job active", { jobId });
    });
    queueEvents.on("progress", ({ jobId, data }) => {
        log.debug("Job progress", { jobId, data });
    });
}

module.exports = { attachQueueObserver };

