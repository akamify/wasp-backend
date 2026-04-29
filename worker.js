require("dotenv").config();

const { Worker } = require("bullmq");
const { connectDB } = require("./config/db");
const { mongoUri } = require("./config/env");
const { getRedisConnection } = require("./services/queue");
const { Campaign } = require("./models/Campaign");
const { Template } = require("./models/Template");
const { sendTemplateMessageForUser } = require("./services/outboundMessageService");
const { debit, credit, messageCost } = require("./services/walletService");

const concurrency = Math.max(Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 5), 1);
const ratePerSec = Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_PER_SEC || 10), 1);

async function startWorker() {
  await connectDB(mongoUri);

  const worker = new Worker(
    "campaigns",
    async (job) => {
      const { workspaceId, campaignId, templateId, to } = job.data || {};
      if (!workspaceId || !campaignId || !templateId || !to) {
        throw new Error("Invalid job payload");
      }

      const template = await Template.findOne({ _id: templateId, workspaceId });
      if (!template) throw new Error("Template not found");

      try {
        await debit(workspaceId, messageCost(1), "Message send (campaign)", {
          campaignId,
          templateId,
          to,
        });
        await sendTemplateMessageForUser({
          userId: workspaceId,
          template,
          to,
        });

        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          { $inc: { "totals.queued": -1, "totals.sent": 1 } }
        );
        return { ok: true };
      } catch (err) {
        if (err?.response) {
          try {
            await credit(workspaceId, messageCost(1), "Message refund (campaign failed)", "internal", "", {
              campaignId,
              templateId,
              to,
            });
          } catch {}
        }
        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          {
            $inc: { "totals.queued": -1, "totals.failed": 1 },
            $set: { lastError: { message: err.message } },
          }
        );
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency,
      limiter: { max: ratePerSec, duration: 1000 },
    }
  );

  worker.on("completed", async () => {});
  worker.on("failed", async (job, err) => {
    console.error("Job failed:", job?.id, err?.message || err);
  });

  console.log(`Campaign worker running (concurrency=${concurrency}, rate=${ratePerSec}/s)`);
}

startWorker().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});
