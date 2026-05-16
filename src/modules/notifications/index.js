module.exports = {
  controllers: require("@modules/notifications/controllers/index"),
  services: require("@modules/notifications/services/index"),
  repositories: require("@modules/notifications/repositories/index"),
  validations: require("@modules/notifications/validations/index"),
  dto: require("@modules/notifications/dto/index"),
  constants: require("@modules/notifications/constants/index"),
  utils: require("@modules/notifications/utils/index"),
  events: require("@modules/notifications/events/index"),
};

