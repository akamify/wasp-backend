module.exports = {
    router: require("@modules/campaigns/routes/campaigns.routes"),
    controllers: require("@modules/campaigns/controllers/index"),
    services: require("@modules/campaigns/services/index"),
    repositories: require("@modules/campaigns/repositories/index"),
    validations: require("@modules/campaigns/validations/index"),
    dto: require("@modules/campaigns/dto/index"),
    constants: require("@modules/campaigns/constants/index"),
    utils: require("@modules/campaigns/utils/index"),
    events: require("@modules/campaigns/events/index"),
};
