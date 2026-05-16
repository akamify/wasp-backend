const { campaignQueue } = require("@infra/queues");

function getCampaignQueue() {
  // Legacy shim: keep existing helper name for controllers.
  return campaignQueue.getCampaignQueue();
}

module.exports = { getCampaignQueue };
