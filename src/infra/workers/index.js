const { startCampaignWorker } = require("@infra/workers/campaign.worker");
const { startRetryWorker } = require("@infra/workers/retry.worker");
const { startNotificationWorker } = require("@infra/workers/notification.worker");
const { startCleanupWorker } = require("@infra/workers/cleanup.worker");
const { startCrmLeadAssignmentWorker } = require("@infra/workers/crmLeadAssignment.worker");
const logger = require("@core/logger/logger");
const { closeAllQueueResources } = require("@infra/queues/index");

let _started = [];

function startAllWorkers() {
    if (_started.length) return _started;
    _started = [
        startCampaignWorker(),
        startRetryWorker(),
        startNotificationWorker(),
        startCleanupWorker(),
        startCrmLeadAssignmentWorker(),
    ].filter(Boolean);
    return _started;
}

async function stopAllWorkers() {
    const current = _started;
    _started = [];

    for (const workerLike of current) {
        try {
            if (typeof workerLike?.close === "function") {
                await workerLike.close();
                continue;
            }
            if (typeof workerLike?.stop === "function") {
                await workerLike.stop();
            }
        } catch (err) {
            logger.warn("Worker shutdown warning", { message: err?.message || String(err) });
        }
    }

    await closeAllQueueResources();
}

module.exports = {
    startCampaignWorker,
    startRetryWorker,
    startNotificationWorker,
    startCleanupWorker,
    startCrmLeadAssignmentWorker,
    startAllWorkers,
    stopAllWorkers,
};
