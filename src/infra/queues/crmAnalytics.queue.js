const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

const name = QUEUE_NAMES.CRM_ANALYTICS;

let _queue = null;
let _events = null;
let _scheduler = null;

function getCrmAnalyticsQueue() {
  if (_queue) return _queue;
  _queue = createQueue(name, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    },
  });
  _events = createQueueEvents(name);
  _scheduler = createQueueScheduler(name);
  return _queue;
}

async function closeCrmAnalyticsQueueResources() {
  await Promise.allSettled([_events?.close?.(), _scheduler?.close?.(), _queue?.close?.()]);
  _queue = null;
  _events = null;
  _scheduler = null;
}

module.exports = {
  getCrmAnalyticsQueue,
  closeCrmAnalyticsQueueResources,
};

