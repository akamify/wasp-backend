const { webhookQueue } = require("@infra/queues/index");
const { createWorker } = require("@infra/queues/queueFactory");
const { attachQueueObserver } = require("@infra/queues/queueObserver");
const {
  deliverExternalWebhookJob,
} = require("@modules/external-chat/services/externalWebhook.service");
const ecommerceStoreService = require("@modules/ecommerce/services/ecommerceStore.service");
const logger = require("@core/logger/logger");

async function handleWebhookJob(job) {
  if (job?.name === "commerce.delivery.branches") return require("@modules/commerce/delivery/branches").run();
  if (job?.name === "commerce.delivery.auto") return require("@modules/commerce/delivery/autoDispatch").run();
  if (job?.name === "commerce.delivery.recover") {
    await require("@modules/commerce/delivery/readiness").ready();
    return require("@modules/commerce/delivery/service").expireOffers();
  }
  if (job?.name === "commerce.payments.recover") {
    try {
      const recovery = await require("@modules/commerce/services/paymentRecovery.service").run();
      const events = await require("@modules/commerce/services/paymentWebhooks.service").run();
      const notifications = await require("@modules/commerce/services/paymentOutbox.service").run();
      return { recovery, events, notifications };
    } catch { throw new Error("Commerce payment recovery failed; durable records remain pending."); }
  }
  if (job?.name === "commerce.orders.intake") {
    try {
      return await require("@modules/commerce/services/orderIntake.service").runOrderIntake();
    } catch {
      throw new Error("Commerce order intake failed");
    }
  }
  if (job?.name === "commerce.gateway.maintain") {
    if (
      process.env.COMMERCE_GATEWAY_ENABLED !== "true" ||
      process.env.COMMERCE_RAZORPAY_OAUTH_ENABLED !== "true"
    )
      return { skipped: true };
    try {
      await require("@modules/commerce/services/gatewayReadiness.service").assertGatewayReady();
      return await require("@modules/commerce/services/gateway.service").maintain();
    } catch {
      throw new Error("Commerce gateway maintenance failed");
    }
  }
  if (job?.name === "commerce.catalog.sync") {
    return require("@modules/commerce/services/catalogSync.service").runCatalogSync();
  }
  if (job?.name === "external-chat.deliver") {
    return deliverExternalWebhookJob(job);
  }
  if (job?.name === "ecommerce.custom.process") {
    return ecommerceStoreService.processCustomEventJob(job);
  }
  return { skipped: true };
}

function startWebhookWorker() {
  if (require("@modules/commerce/delivery/routingSettings").routingEnabled()) webhookQueue.getWebhookQueue().upsertJobScheduler("commerce-delivery-branches", { every: 10000 }, {
    name: "commerce.delivery.branches", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 },
  }).catch(() => logger.warn("Branch selection scheduler unavailable", { event: "commerce_branch_scheduler_failed" }));
  if (require("@modules/commerce/delivery/routingSettings").autoEnabled()) webhookQueue.getWebhookQueue().upsertJobScheduler("commerce-delivery-auto", { every: 5000 }, {
    name: "commerce.delivery.auto", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 },
  }).catch((err) => logger.error({ error: err.message }, "Commerce automatic dispatch scheduler failed"));
  if (process.env.COMMERCE_DELIVERY_ENABLED === "true") webhookQueue.getWebhookQueue().upsertJobScheduler("commerce-delivery-recover", { every: 5000 }, {
    name: "commerce.delivery.recover", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 },
  }).catch(() => logger.warn("Delivery recovery scheduler could not start"));
  if (process.env.COMMERCE_PAYMENTS_ENABLED === "true") {
    webhookQueue.getWebhookQueue().upsertJobScheduler("commerce-payments-recover", { every: 60000 }, {
      name: "commerce.payments.recover", data: {}, opts: { removeOnComplete: 100, removeOnFail: 100 },
    }).catch(() => logger.warn("Commerce payment recovery scheduler could not start"));
  }
  if (process.env.COMMERCE_ORDERS_ENABLED === "true") {
    webhookQueue
      .getWebhookQueue()
      .upsertJobScheduler(
        "commerce-orders-intake",
        { every: 15000 },
        {
          name: "commerce.orders.intake",
          data: {},
          opts: { removeOnComplete: 100, removeOnFail: 100 },
        },
      )
      .catch(() =>
        logger.warn("Commerce order intake scheduler could not start"),
      );
  }
  if (
    process.env.COMMERCE_GATEWAY_ENABLED === "true" &&
    process.env.COMMERCE_RAZORPAY_OAUTH_ENABLED === "true"
  ) {
    webhookQueue
      .getWebhookQueue()
      .upsertJobScheduler(
        "commerce-gateway-maintain",
        { every: 60000 },
        {
          name: "commerce.gateway.maintain",
          data: {},
          opts: { removeOnComplete: 100, removeOnFail: 100 },
        },
      )
      .catch(() => logger.warn("Commerce gateway scheduler could not start"));
  }
  if (process.env.COMMERCE_CATALOG_ENABLED === "true") {
    webhookQueue
      .getWebhookQueue()
      .upsertJobScheduler(
        "commerce-catalog-sync",
        { every: 15000 },
        {
          name: "commerce.catalog.sync",
          data: {},
          opts: { removeOnComplete: 100, removeOnFail: 100 },
        },
      )
      .catch(() => logger.warn("Commerce catalog scheduler could not start"));
  }
  webhookQueue.getWebhookQueueScheduler();
  const events = webhookQueue.getWebhookQueueEvents();
  attachQueueObserver("webhook", events);

  const worker = createWorker("webhook", handleWebhookJob, {
    concurrency: Math.max(
      Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 3),
      1,
    ),
  });

  worker.on("failed", (job, err) => {
    logger.warn("Webhook job failed", {
      jobId: job?.id,
      name: job?.name,
      message: err?.message || String(err),
    });
  });

  logger.info("Webhook worker running");
  return worker;
}

module.exports = { startWebhookWorker };
