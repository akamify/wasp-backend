const { CampaignRun } = require("@infra/database/CampaignRun");

async function getOrCreateCampaignRun({ workspaceId, campaignId, scheduledFor }) {
    try {
        const run = await CampaignRun.create({
            workspaceId,
            campaignId,
            scheduledFor,
            status: "pending",
        });
        return { run, created: true };
    } catch (err) {
        if (Number(err?.code) !== 11000) throw err;
        const run = await CampaignRun.findOne({ campaignId, scheduledFor });
        return { run, created: false };
    }
}

function markCampaignRunRunning({ runId, total }) {
    return CampaignRun.findOneAndUpdate(
        { _id: runId, status: { $in: ["pending", "running", "failed"] } },
        {
            $set: { status: "running", total, startedAt: new Date() },
            $unset: { error: 1, completedAt: 1 },
        },
        { new: true }
    );
}

function markCampaignRunFailed({ runId, error }) {
    return CampaignRun.updateOne(
        { _id: runId, status: { $ne: "completed" } },
        {
            $set: {
                status: "failed",
                completedAt: new Date(),
                error: { message: error?.message || String(error || "Campaign run failed") },
            },
        }
    );
}

async function finalizeCampaignRunMessage({ runId, sent }) {
    const increment = sent ? { processed: 1, sent: 1 } : { processed: 1, failed: 1 };
    const run = await CampaignRun.findOneAndUpdate(
        { _id: runId, status: "running" },
        { $inc: increment },
        { new: true }
    );
    if (!run || Number(run.processed || 0) < Number(run.total || 0)) return run;
    return CampaignRun.findOneAndUpdate(
        { _id: runId, status: "running", processed: { $gte: Number(run.total || 0) } },
        { $set: { status: "completed", completedAt: new Date() } },
        { new: true }
    );
}

module.exports = {
    getOrCreateCampaignRun,
    markCampaignRunRunning,
    markCampaignRunFailed,
    finalizeCampaignRunMessage,
};
