const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { CAMPAIGN_STATUSES, CAMPAIGN_TYPES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { campaignsRepository, messagesRepository } = require("@modules/campaigns/repositories/index");
const { campaignQueue } = require("@infra/queues/index");

async function updateCampaignStatus(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const action = String(req.body?.action || "").toLowerCase();
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");

    const currentStatus = String(campaign.status || "").toLowerCase();
    const isStopped = currentStatus === CAMPAIGN_STATUSES.CANCELED || currentStatus === CAMPAIGN_STATUSES.CANCELLED;
    const isPaused = currentStatus === CAMPAIGN_STATUSES.PAUSED;
    const isLive = currentStatus === CAMPAIGN_STATUSES.RUNNING;
    const isApiCampaign = String(campaign.type || "") === CAMPAIGN_TYPES.API;
    const allowedActions = isLive ? new Set(["pause", "stop", ...(isApiCampaign ? ["complete"] : [])]) : isPaused ? new Set(["resume", "stop"]) : new Set([]);
    if (isStopped || !allowedActions.has(action)) throw new HttpError(400, "Action not allowed for current campaign status");

    const nextStatus = action === "pause" ? CAMPAIGN_STATUSES.PAUSED : action === "resume" ? CAMPAIGN_STATUSES.QUEUED : action === "stop" ? CAMPAIGN_STATUSES.CANCELED : action === "complete" ? CAMPAIGN_STATUSES.COMPLETED : null;
    if (!nextStatus) throw new HttpError(400, "Invalid action");

    if (action === "pause" || action === "resume" || action === "stop") {
        try {
            const queue = campaignQueue.getCampaignQueue();
            const campaignId = String(campaign._id);
            if (action === "pause") {
                const jobs = await queue.getJobs(["waiting", "prioritized"], 0, 5000);
                await Promise.all(jobs.filter((job) => String(job?.data?.campaignId || "") === campaignId).map((job) => job.moveToDelayed(Date.now() + 365 * 24 * 60 * 60 * 1000)));
            }
            if (action === "resume") {
                const jobs = await queue.getJobs(["delayed"], 0, 5000);
                await Promise.all(jobs.filter((job) => String(job?.data?.campaignId || "") === campaignId).map((job) => job.promote()));
            }
            if (action === "stop") {
                const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized", "paused"], 0, 5000);
                let removed = 0;
                await Promise.all(jobs.filter((job) => String(job?.data?.campaignId || "") === campaignId).map(async (job) => { try { await job.remove(); removed += 1; } catch {} }));
                if (campaign.totals?.queued && removed > 0) campaign.totals.queued = Math.max(Number(campaign.totals.queued || 0) - removed, 0);
            }
        } catch {}
    }

    campaign.status = nextStatus;
    if (campaign.schedule && String(campaign.schedule.frequency || "") !== "once") {
        if (action === "stop") campaign.schedule.status = "canceled";
        if (action === "complete") campaign.schedule.status = "completed";
        if (action === "resume" && campaign.schedule.nextRunAt) campaign.schedule.status = "active";
    }
    await campaign.save();
    emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, { campaignId: String(campaign._id), status: nextStatus });
    return { success: true, campaign };
}

async function deleteCampaign(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const force = String(req.query.force || "").toLowerCase() === "true";
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");
    const runningStatuses = new Set([CAMPAIGN_STATUSES.QUEUED, CAMPAIGN_STATUSES.RUNNING, CAMPAIGN_STATUSES.PAUSED]);
    if (!force && runningStatuses.has(String(campaign.status || "").toLowerCase())) throw new HttpError(409, "Campaign is active. Stop it first or pass force=true to delete.");

    try {
        const queue = campaignQueue.getCampaignQueue();
        const jobs = await queue.getJobs(["waiting", "delayed", "active", "prioritized", "paused"], 0, 5000);
        await Promise.all(jobs.filter((job) => String(job?.data?.campaignId || "") === String(campaign._id)).map(async (job) => { try { await job.remove(); } catch {} }));
    } catch {}

    const [msgDelete, campDelete] = await Promise.all([
        messagesRepository.deleteMessages({ workspaceId: req.workspace.id, wabaId: campaign.wabaId, campaignId: campaign._id }),
        campaignsRepository.deleteCampaign({ _id: campaign._id, workspaceId: req.workspace.id, wabaId: campaign.wabaId }),
    ]);
    return { success: true, deleted: { campaignId: String(campaign._id), campaigns: Number(campDelete?.deletedCount || 0), messages: Number(msgDelete?.deletedCount || 0) } };
}

module.exports = { updateCampaignStatus, deleteCampaign };
