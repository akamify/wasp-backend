module.exports = {
  router: require("@modules/workspaces/workspaces.routes"),
  controllers: require("@modules/workspaces/controllers/index"),
  services: require("@modules/workspaces/services/index"),
  repositories: require("@modules/workspaces/repositories/index"),
  validations: require("@modules/workspaces/validations/index"),
  events: require("@modules/workspaces/events/index"),
  constants: require("@modules/workspaces/constants/index"),
};

