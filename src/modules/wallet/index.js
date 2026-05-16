module.exports = {
  router: require("@modules/wallet/routes/wallet.routes"),
  controllers: require("@modules/wallet/controllers/index"),
  services: require("@modules/wallet/services/index"),
  repositories: require("@modules/wallet/repositories/index"),
  validations: require("@modules/wallet/validations/index"),
  dto: require("@modules/wallet/dto/index"),
  constants: require("@modules/wallet/constants/index"),
  utils: require("@modules/wallet/utils/index"),
  events: require("@modules/wallet/events/index"),
};

