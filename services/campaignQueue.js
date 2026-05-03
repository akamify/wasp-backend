const { createQueue } = require("./queue");

let _campaignQueue;

function getCampaignQueue() {
  // Lazy init so API server can boot even if Redis is temporarily unavailable.
  // This also avoids noisy reconnect logs on startup when campaigns aren't being used.
  if (_campaignQueue) return _campaignQueue;
  _campaignQueue = createQueue("campaigns");
  return _campaignQueue;
}

module.exports = { getCampaignQueue };
