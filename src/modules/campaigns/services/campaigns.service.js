const analytics = require("@modules/campaigns/services/campaignAnalytics.service");
const estimate = require("@modules/campaigns/services/campaignEstimate.service");
const creation = require("@modules/campaigns/services/campaignCreation.service");
const recipients = require("@modules/campaigns/services/campaignRecipients.service");
const status = require("@modules/campaigns/services/campaignStatus.service");

module.exports = {
    ...analytics,
    ...estimate,
    ...creation,
    ...recipients,
    ...status,
};
