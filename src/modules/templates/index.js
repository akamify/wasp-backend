module.exports = {
  router: require("@modules/templates/routes/templates.routes"),
  controllers: require("@modules/templates/controllers/index"),
  services: require("@modules/templates/services/index"),
  repositories: require("@modules/templates/repositories/index"),
  validations: require("@modules/templates/validations/index"),
  dto: require("@modules/templates/dto/index"),
  constants: require("@modules/templates/constants/index"),
  utils: require("@modules/templates/utils/index"),
  events: require("@modules/templates/events/index"),
};

