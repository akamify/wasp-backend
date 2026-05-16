const campaignsIntegrationService = require("@modules/campaigns/services/campaignsIntegration.service");

async function sendApiCampaignByName(req, res) {
    const result = await campaignsIntegrationService.sendApiCampaignByName(req);
    res.status(201).json(result);
}

module.exports = { sendApiCampaignByName };
