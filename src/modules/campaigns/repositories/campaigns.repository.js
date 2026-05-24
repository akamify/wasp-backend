const { Campaign } = require("@infra/database/Campaign");

function listCampaignsByWorkspace(workspaceId, limit) {
    return Campaign.find({ workspaceId }).sort({ createdAt: -1 }).limit(limit);
}

function getCampaignById({ id, workspaceId }) {
    return Campaign.findOne({ _id: id, workspaceId });
}

function getCampaignByIdLean({ id, workspaceId, select }) {
    return Campaign.findOne({ _id: id, workspaceId }).select(select || undefined).lean();
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

function countCampaignsCreatedBetween({ workspaceId, start, end }) {
    return Campaign.countDocuments({
        workspaceId,
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
