const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

let _queue;
let _events;
let _scheduler;

function getRetryQueue() {
    if (_queue) return _queue;
    _queue = createQueue(QUEUE_NAMES.RETRY, {
        defaultJobOptions: {
            attempts: Math.max(Number(process.env.RETRY_JOB_ATTEMPTS || 5), 1),
            backoff: { type: "exponential", delay: 10_000 },
            removeOnComplete: 5000,
            removeOnFail: 5000,
        },
    });
    return _queue;
}

function getRetryQueueEvents() {
    if (_events) return _events;
    _events = createQueueEvents(QUEUE_NAMES.RETRY);
    return _events;
}

function getRetryQueueScheduler() {
    if (_scheduler) return _scheduler;
    _scheduler = createQueueScheduler(QUEUE_NAMES.RETRY);
    return _scheduler;
}

async function closeRetryQueueResources() {
    const resources = [_events, _scheduler, _queue];
    _events = null;
    _scheduler = null;
    _queue = null;
    for (const resource of resources) {
        if (!resource || typeof resource.close !== "function") continue;
        await resource.close();
    }
}

module.exports = { getRetryQueue, getRetryQueueEvents, getRetryQueueScheduler, closeRetryQueueResources };
