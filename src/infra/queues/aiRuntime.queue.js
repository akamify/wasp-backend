const { createQueue, createQueueEvents, createQueueScheduler } = require("@infra/queues/queueFactory");
const { QUEUE_NAMES } = require("@infra/queues/queueNames");

const name = QUEUE_NAMES.AI_RUNTIME;

let _queue = null;
let _events = null;
let _scheduler = null;

function getAiRuntimeQueue() {
  if (_queue) return _queue;
  _queue = createQueue(name, {
    defaultJobOptions: {
      attempts: Math.max(Number(process.env.AI_RUNTIME_JOB_ATTEMPTS || 3), 1),
      backoff: { type: "exponential", delay: Math.max(Number(process.env.AI_RUNTIME_JOB_BACKOFF_MS || 1500), 250) },
      removeOnComplete: 2000,
      removeOnFail: 3000,
    },
  });
  _events = createQueueEvents(name);
  _scheduler = createQueueScheduler(name);
  return _queue;
}

async function closeAiRuntimeQueueResources() {
  await Promise.allSettled([_events?.close?.(), _scheduler?.close?.(), _queue?.close?.()]);
  _queue = null;
  _events = null;
  _scheduler = null;
}

module.exports = {
  getAiRuntimeQueue,
  closeAiRuntimeQueueResources,
};
