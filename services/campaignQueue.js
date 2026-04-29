const { createQueue } = require("./queue");

const campaignQueue = createQueue("campaigns");

module.exports = { campaignQueue };

