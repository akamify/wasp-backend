const {
  createQueue,
  createQueueEvents,
  createQueueScheduler,
} = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

let queue;
let events;
let scheduler;

function getFlowSessionExpiryQueue() {
  if (queue) return queue;
  queue = createQueue(QUEUE_NAMES.FLOW_SESSION_EXPIRY, {
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
  return queue;
}

function getFlowSessionExpiryQueueEvents() {
  if (events) return events;
  events = createQueueEvents(QUEUE_NAMES.FLOW_SESSION_EXPIRY);
  return events;
}

function getFlowSessionExpiryQueueScheduler() {
  if (scheduler) return scheduler;
  scheduler = createQueueScheduler(QUEUE_NAMES.FLOW_SESSION_EXPIRY);
  return scheduler;
}

async function closeFlowSessionExpiryQueueResources() {
  const resources = [events, scheduler, queue];
  events = null;
  scheduler = null;
  queue = null;
  for (const resource of resources) {
    if (!resource || typeof resource.close !== "function") continue;
    await resource.close();
  }
}

module.exports = {
  getFlowSessionExpiryQueue,
  getFlowSessionExpiryQueueEvents,
  getFlowSessionExpiryQueueScheduler,
  closeFlowSessionExpiryQueueResources,
};
