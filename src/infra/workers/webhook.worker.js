const { webhookQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const { deliverExternalWebhookJob } = require("@modules/external-chat/services/externalWebhook.service");
const logger = require("@core/logger/logger");

async function handleWebhookJob(job) {
  if (job?.name !== "external-chat.deliver") {
    return { skipped: true };
  }
  return deliverExternalWebhookJob(job);
}

function startWebhookWorker() {
  webhookQueue.getWebhookQueueScheduler();
  const events = webhookQueue.getWebhookQueueEvents();
  attachQueueObserver("webhook", events);

  const worker = createWorker("webhook", handleWebhookJob, {
    concurrency: Math.max(Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 3), 1),
  });

  worker.on("failed", (job, err) => {
    logger.warn("Webhook job failed", { jobId: job?.id, name: job?.name, message: err?.message || String(err) });
  });

  logger.info("Webhook worker running");
  return worker;
}

module.exports = { startWebhookWorker };
