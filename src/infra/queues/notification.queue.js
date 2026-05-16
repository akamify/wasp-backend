const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

let _queue;
let _events;
let _scheduler;

function getNotificationQueue() {
    if (_queue) return _queue;
    _queue = createQueue(QUEUE_NAMES.NOTIFICATION, {
        defaultJobOptions: {
            attempts: Math.max(Number(process.env.NOTIFICATION_JOB_ATTEMPTS || 2), 1),
            backoff: { type: "fixed", delay: 5000 },
            removeOnComplete: 2000,
            removeOnFail: 5000,
        },
    });
    return _queue;
}

function getNotificationQueueEvents() {
    if (_events) return _events;
    _events = createQueueEvents(QUEUE_NAMES.NOTIFICATION);
    return _events;
}

function getNotificationQueueScheduler() {
    if (_scheduler) return _scheduler;
    _scheduler = createQueueScheduler(QUEUE_NAMES.NOTIFICATION);
    return _scheduler;
}

async function closeNotificationQueueResources() {
    const resources = [_events, _scheduler, _queue];
    _events = null;
    _scheduler = null;
    _queue = null;
    for (const resource of resources) {
        if (!resource || typeof resource.close !== "function") continue;
        await resource.close();
    }
}

module.exports = {
    getNotificationQueue,
    getNotificationQueueEvents,
    getNotificationQueueScheduler,
    closeNotificationQueueResources,
};
