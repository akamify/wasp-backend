const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

let _queue;
let _events;
let _scheduler;

function getCampaignQueue() {
    if (_queue) return _queue;
    _queue = createQueue(QUEUE_NAMES.CAMPAIGN, {
        defaultJobOptions: {
            attempts: Math.max(Number(process.env.CAMPAIGN_JOB_ATTEMPTS || 3), 1),
            backoff: { type: "exponential", delay: 5000 },
            removeOnComplete: 5000,
            removeOnFail: 5000,
        },
    });
    return _queue;
}

function getCampaignQueueEvents() {
    if (_events) return _events;
    _events = createQueueEvents(QUEUE_NAMES.CAMPAIGN);
    return _events;
}

function getCampaignQueueScheduler() {
    if (_scheduler) return _scheduler;
    _scheduler = createQueueScheduler(QUEUE_NAMES.CAMPAIGN);
    return _scheduler;
}

async function closeCampaignQueueResources() {
    const resources = [
        { ref: _events, key: "_events" },
        { ref: _scheduler, key: "_scheduler" },
        { ref: _queue, key: "_queue" },
    ];
    _events = null;
    _scheduler = null;
    _queue = null;
    for (const resource of resources) {
        if (!resource.ref || typeof resource.ref.close !== "function") continue;
        await resource.ref.close();
    }
}

module.exports = { getCampaignQueue, getCampaignQueueEvents, getCampaignQueueScheduler, closeCampaignQueueResources };
