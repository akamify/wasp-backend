module.exports = {
  controllers: require("@modules/billing/controllers/index"),
  services: require("@modules/billing/services/index"),
  repositories: require("@modules/billing/repositories/index"),
  validations: require("@modules/billing/validations/index"),
  dto: require("@modules/billing/dto/index"),
  constants: require("@modules/billing/constants/index"),
  utils: require("@modules/billing/utils/index"),
  events: require("@modules/billing/events/index"),
};

