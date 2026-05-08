require("./config/loadEnv").loadEnv();

const { Worker } = require("bullmq");
const { connectDB } = require("./config/db");
const { mongoUri } = require("./config/env");
const { getRedisConnection } = require("./services/queue");
const { Campaign } = require("./models/Campaign");
const { Template } = require("./models/Template");
const { sendTemplateMessageForUser } = require("./services/outboundMessageService");
const { debit, credit, messageCostForTemplateCategory } = require("./services/walletService");
const { isCustomerServiceWindowOpen } = require("./services/pricingService");

const concurrency = Math.max(Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 5), 1);
const ratePerSec = Math.max(Number(process.env.CAMPAIGN_RATE_LIMIT_PER_SEC || 10), 1);

async function finalizeCampaignIfDone({ workspaceId, campaignId }) {
  try {
    const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("status totals type").lean();
    if (!campaign) return;
    if (String(campaign.type || "") === "api") return;
    const queued = Number(campaign?.totals?.queued || 0);
    if (queued > 0) return;
    const status = String(campaign.status || "");
    if (!["draft", "queued", "running"].includes(status)) return;
    const sent = Number(campaign?.totals?.sent || 0);
    const failed = Number(campaign?.totals?.failed || 0);
    const nextStatus = sent === 0 && failed > 0 ? "failed" : "completed";
    await Campaign.updateOne({ _id: campaignId, workspaceId }, { $set: { status: nextStatus } });
  } catch { }
}

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
      if (status === "paused" || status === "canceled" || status === "cancelled" || status === "completed" || status === "failed") {
        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          { $inc: { "totals.queued": -1 } }
        );
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true, skipped: true, status };
      }

      if (status === "queued") {
        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $set: { status: "running" } });
      }

      const updatedStatus = status === "queued" ? "running" : status;
      if (updatedStatus !== "running") {
        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          { $inc: { "totals.queued": -1 } }
        );
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true, skipped: true, status: updatedStatus };
      }

      const template = await Template.findOne({ _id: templateId, workspaceId });
      if (!template) throw new Error("Template not found");

      const windowOpen = await isCustomerServiceWindowOpen({ workspaceId, phone: to });
      const chargeAmount = windowOpen ? 0 : messageCostForTemplateCategory(template.category, 1);
      try {
        if (chargeAmount > 0) {
          await debit(workspaceId, chargeAmount, "Message send (campaign)", {
            campaignId,
            templateId,
            to,
          });
        }
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
        await finalizeCampaignIfDone({ workspaceId, campaignId });
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
        } catch { }
        if (err?.response) {
          try {
            if (chargeAmount > 0) {
              await credit(workspaceId, chargeAmount, "Message refund (campaign failed)", "internal", "", {
                campaignId,
                templateId,
                to,
              });
            }
          } catch { }
        }
        await Campaign.updateOne(
          { _id: campaignId, workspaceId },
          {
            $inc: { "totals.queued": -1, "totals.failed": 1 },
            $set: { lastError: { message: err.message } },
          }
        );
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        throw err;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency,
      limiter: { max: ratePerSec, duration: 1000 },
    }
  );

  worker.on("completed", async () => { });
  worker.on("failed", async (job, err) => {
    console.error("Job failed:", job?.id, err?.message || err);
  });

  console.log(`Campaign worker running (concurrency=${concurrency}, rate=${ratePerSec}/s)`);
}

startWorker().catch((err) => {
  console.error("Failed to start worker:", err);
  process.exit(1);
});
