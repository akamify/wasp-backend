const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

let _queue;
let _events;
let _scheduler;

function getWebhookQueue() {
    if (_queue) return _queue;
    _queue = createQueue(QUEUE_NAMES.WEBHOOK, {
        defaultJobOptions: {
            attempts: Math.max(Number(process.env.WEBHOOK_JOB_ATTEMPTS || 3), 1),
            backoff: { type: "exponential", delay: 5000 },
            removeOnComplete: 2000,
            removeOnFail: 5000,
        },
    });
    return _queue;
}

function getWebhookQueueEvents() {
    if (_events) return _events;
    _events = createQueueEvents(QUEUE_NAMES.WEBHOOK);
    return _events;
}

function getWebhookQueueScheduler() {
    if (_scheduler) return _scheduler;
    _scheduler = createQueueScheduler(QUEUE_NAMES.WEBHOOK);
    return _scheduler;
}

async function closeWebhookQueueResources() {
    const resources = [_events, _scheduler, _queue];
    _events = null;
    _scheduler = null;
    _queue = null;
    for (const resource of resources) {
        if (!resource || typeof resource.close !== "function") continue;
        await resource.close();
    }
}

module.exports = { getWebhookQueue, getWebhookQueueEvents, getWebhookQueueScheduler, closeWebhookQueueResources };
