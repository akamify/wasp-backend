const { Campaign } = require("@infra/database/Campaign");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

async function listCampaignsByWorkspace(workspaceId, limit) {
    const scope = await requireActiveWabaScope(workspaceId);
    return Campaign.find({ workspaceId, wabaId: scope.wabaId }).sort({ createdAt: -1 }).limit(limit);
}

async function getCampaignById({ id, workspaceId }) {
    const scope = await requireActiveWabaScope(workspaceId);
    return Campaign.findOne({ _id: id, workspaceId, wabaId: scope.wabaId });
}

async function getCampaignByIdLean({ id, workspaceId, select }) {
    const scope = await requireActiveWabaScope(workspaceId);
    return Campaign.findOne({ _id: id, workspaceId, wabaId: scope.wabaId }).select(select || undefined).lean();
}

function createCampaign(data) {
    return Campaign.create(data);
}

function updateCampaign(query, update) {
    return Campaign.updateOne(query, update);
}

function findCampaignForScheduledDispatch({ campaignId, workspaceId }) {
    return Campaign.findOne({ _id: campaignId, workspaceId }).select(
        "_id workspaceId wabaId templateId type status audience schedule recipientSnapshot totals templateVariableMappings headerVariableMappings buttonVariableMappings"
    );
}

function acquireScheduledCampaignLock({ campaignId, workspaceId, now, lockUntil, lockedBy }) {
    return Campaign.findOneAndUpdate(
        {
            _id: campaignId,
            workspaceId,
            "schedule.status": "active",
            "schedule.nextRunAt": { $lte: now },
            $or: [
                { "schedule.lockUntil": { $exists: false } },
                { "schedule.lockUntil": null },
                { "schedule.lockUntil": { $lt: now } },
            ],
            status: { $nin: ["paused", "completed", "failed", "canceled", "cancelled"] },
        },
        {
            $set: {
                "schedule.lockUntil": lockUntil,
                "schedule.lockedBy": lockedBy,
            },
        },
        { new: true }
    ).select(
        "_id workspaceId wabaId templateId type status audience schedule recipientSnapshot totals templateVariableMappings headerVariableMappings buttonVariableMappings"
    );
}

function releaseScheduledCampaignLock({ campaignId, workspaceId, lockedBy, update = {} }) {
    const $set = { ...(update.$set || {}), "schedule.lockUntil": null, "schedule.lockedBy": null };
    const normalizedUpdate = { ...update, $set };
    return Campaign.updateOne(
        { _id: campaignId, workspaceId, "schedule.lockedBy": lockedBy },
        normalizedUpdate
    );
}

function listActiveScheduledCampaigns({ limit }) {
    return Campaign.find({
        "schedule.status": "active",
        "schedule.nextRunAt": { $ne: null },
        status: { $nin: ["completed", "failed", "canceled", "cancelled"] },
    })
        .select("_id workspaceId schedule.nextRunAt")
        .sort({ "schedule.nextRunAt": 1 })
        .limit(limit);
}

function listDueScheduledCampaigns({ now, limit }) {
    return Campaign.find({
        "schedule.status": "active",
        "schedule.nextRunAt": { $lte: now },
        status: { $nin: ["paused", "completed", "failed", "canceled", "cancelled"] },
        $or: [
            { "schedule.lockUntil": { $exists: false } },
            { "schedule.lockUntil": null },
            { "schedule.lockUntil": { $lt: now } },
        ],
    })
        .select("_id workspaceId schedule.nextRunAt")
        .sort({ "schedule.nextRunAt": 1 })
        .limit(limit)
        .lean();
}

function deleteCampaign(query) {
    return Campaign.deleteOne(query);
}

function incrementCampaignTotals(query, update) {
    return Campaign.updateOne(query, update);
}

async function countCampaignsCreatedBetween({ workspaceId, start, end }) {
    const scope = await requireActiveWabaScope(workspaceId);
    return Campaign.countDocuments({
        workspaceId,
        wabaId: scope.wabaId,
        createdAt: { $gte: start, $lt: end },
    });
}

module.exports = {
    listCampaignsByWorkspace,
    getCampaignById,
    getCampaignByIdLean,
    createCampaign,
    updateCampaign,
    findCampaignForScheduledDispatch,
    acquireScheduledCampaignLock,
    releaseScheduledCampaignLock,
    listActiveScheduledCampaigns,
    listDueScheduledCampaigns,
    deleteCampaign,
    incrementCampaignTotals,
    countCampaignsCreatedBetween,
};
