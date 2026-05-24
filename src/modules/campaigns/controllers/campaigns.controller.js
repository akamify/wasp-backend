const campaignsService = require("@modules/campaigns/services/campaigns.service");

async function listCampaigns(req, res) {
    res.json(await campaignsService.listCampaigns(req));
}

async function getCampaign(req, res) {
    res.json(await campaignsService.getCampaign(req));
}

async function getCampaignMetrics(req, res) {
    res.json(await campaignsService.getCampaignMetrics(req));
}

async function listCampaignMessages(req, res) {
    res.json(await campaignsService.listCampaignMessages(req));
}

async function listCampaignReplies(req, res) {
    res.json(await campaignsService.listCampaignReplies(req));
}

async function getCampaignCreditUsage(req, res) {
    res.json(await campaignsService.getCampaignCreditUsage(req));
}

async function updateCampaignStatus(req, res) {
    res.json(await campaignsService.updateCampaignStatus(req));
}

async function estimateCampaign(req, res) {
    res.json(await campaignsService.estimateCampaign(req));
}

async function createCampaign(req, res) {
    const result = await campaignsService.createCampaign(req);
    res.status(201).json(result);
}

async function retryFailedCampaign(req, res) {
    const result = await campaignsService.retryFailedCampaign(req);
    res.status(201).json(result);
}

async function listFailedRecipients(req, res) {
    res.json(await campaignsService.listFailedRecipients(req));
}

async function deleteCampaign(req, res) {
    res.json(await campaignsService.deleteCampaign(req));
}

module.exports = {
    listCampaigns,
    getCampaign,
    getCampaignMetrics,
    listCampaignMessages,
    listCampaignReplies,
    getCampaignCreditUsage,
    updateCampaignStatus,
    estimateCampaign,
    createCampaign,
    retryFailedCampaign,
    listFailedRecipients,
    deleteCampaign,
};
