const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

const name = QUEUE_NAMES.CRM_EXPORT;

let _queue = null;
let _events = null;
let _scheduler = null;

function getCrmExportQueue() {
  if (_queue) return _queue;
  _queue = createQueue(name, {
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });
  _events = createQueueEvents(name);
  _scheduler = createQueueScheduler(name);
  return _queue;
}

async function closeCrmExportQueueResources() {
  await Promise.allSettled([_events?.close?.(), _scheduler?.close?.(), _queue?.close?.()]);
  _queue = null;
  _events = null;
  _scheduler = null;
}

module.exports = {
  getCrmExportQueue,
  closeCrmExportQueueResources,
};

