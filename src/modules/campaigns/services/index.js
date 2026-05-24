const campaignsService = require("@modules/campaigns/services/campaigns.service");
const campaignsIntegrationService = require("@modules/campaigns/services/campaignsIntegration.service");
const campaignsQueueService = require("@modules/campaigns/services/campaignsQueue.service");

module.exports = { campaignsService, campaignsIntegrationService, campaignsQueueService };
