const {
  sweepExpiredSessions,
} = require("@modules/flows/services/flowSessionExpiry.service");
const {
  flowSessionExpiryQueue,
} = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");

function startFlowSessionExpiryWorker() {
  const intervalMs = Math.max(
    Number(process.env.FLOW_SESSION_EXPIRY_INTERVAL_MS || 60_000),
    10_000
  );
  flowSessionExpiryQueue.getFlowSessionExpiryQueueScheduler();
  const events =
    flowSessionExpiryQueue.getFlowSessionExpiryQueueEvents();
  attachQueueObserver("flow-session-expiry-sweep", events);

  const queue = flowSessionExpiryQueue.getFlowSessionExpiryQueue();
  void queue
    .add(
      "flow-session-expiry-sweep",
      {},
      {
        jobId: "flow-session-expiry-sweep",
        repeat: { every: intervalMs },
      }
    )
    .catch((error) => {
      process.stdout.write(
        `[FLOW_SESSION_EXPIRY_SCHEDULE_FAILED] ${JSON.stringify({
          reason: error?.message || "Unknown error",
        })}\n`
      );
    });

  const worker = createWorker(
    "flow-session-expiry-sweep",
    async () => sweepExpiredSessions(),
    { concurrency: 1 }
  );
  worker.on("failed", (job, error) => {
    process.stdout.write(
      `[FLOW_SESSION_EXPIRY_SWEEP_FAILED] ${JSON.stringify({
        jobId: job?.id || null,
        reason: error?.message || "Unknown error",
      })}\n`
    );
  });
  return worker;
}

module.exports = { startFlowSessionExpiryWorker };
