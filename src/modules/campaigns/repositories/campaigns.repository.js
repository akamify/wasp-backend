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
    deleteCampaign,
    incrementCampaignTotals,
    countCampaignsCreatedBetween,
};
