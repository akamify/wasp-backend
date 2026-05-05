require("dotenv").config();

const { Worker } = require("bullmq");
const { connectDB } = require("./config/db");
const { mongoUri } = require("./config/env");
const { getRedisConnection } = require("./services/queue");
const { Campaign } = require("./models/Campaign");
const { Template } = require("./models/Template");
const { sendTemplateMessageForUser } = require("./services/outboundMessageService");
const { debit, credit, messageCostForTemplateCategory } = require("./services/walletService");

const concurrency = Math.max(Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 5), 1);
const ratePerSec = Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_PER_SEC || 10), 1);

async function startWorker() {
  await connectDB(mongoUri);

  const worker = new Worker(
    "campaigns",
    async (job) => {
      const {
        workspaceId,
        campaignId,
        templateId,
        to,
        variables,
        headerVariables,
        otpCode,
        buttonValues,
        buttonTtlMinutes,
        flowTokens,
        flowActionData,
      } = job.data || {};
      if (!workspaceId || !campaignId || !templateId || !to) {
        throw new Error("Invalid job payload");
      }

      const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("status totals");
      if (!campaign) throw new Error("Campaign not found");
      const status = String(campaign.status || "");
      if (status === "paused" || status === "canceled") {
        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          { $inc: { "totals.queued": -1 } }
        );
        return { ok: true, skipped: true, status };
      }

      const template = await Template.findOne({ _id: templateId, workspaceId });
      if (!template) throw new Error("Template not found");

      const chargeAmount = messageCostForTemplateCategory(template.category, 1);
      try {
        await debit(workspaceId, chargeAmount, "Message send (campaign)", {
          campaignId,
          templateId,
          to,
        });
        await sendTemplateMessageForUser({
          userId: workspaceId,
          campaignId,
          template,
          to,
          variables,
          headerVariables,
          otpCode,
          buttonValues,
          buttonTtlMinutes,
          flowTokens,
          flowActionData,
        });

        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          { $inc: { "totals.queued": -1, "totals.sent": 1 } }
        );
        return { ok: true };
      } catch (err) {
        try {
          const now = new Date();
          await require("./models/Message").Message.create({
            workspaceId,
            campaignId,
            templateId,
            phone: to,
            direction: "outbound",
            status: "failed",
            statusTimestamps: { failedAt: now },
            text: "",
            payload: {
              to,
              template: { id: templateId },
              runtime: {
                variables: variables || [],
                headerVariables: headerVariables || [],
                otpCode: otpCode || "",
                buttonValues: buttonValues || [],
                buttonTtlMinutes: buttonTtlMinutes || [],
                flowTokens: flowTokens || [],
                flowActionData: flowActionData || [],
              },
            },
            error: err?.response?.data || err?.message || err,
          });
        } catch {}
        if (err?.response) {
          try {
            await credit(workspaceId, chargeAmount, "Message refund (campaign failed)", "internal", "", {
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
