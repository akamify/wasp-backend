const { EventEmitter } = require("events");
const { CAMPAIGN_EVENTS } = require("@modules/campaigns/constants/campaign.constants");
const logger = require("@core/logger/logger");

const emitter = new EventEmitter();

function emitCampaignEvent(event, payload) {
    const normalized = payload || {};
    emitter.emit(event, normalized);
    if (typeof logger?.info === "function") {
        logger.info("Campaign event emitted", { event, ...normalized });
    }
}

module.exports = { emitter, emitCampaignEvent, CAMPAIGN_EVENTS };

