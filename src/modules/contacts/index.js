module.exports = {
  router: require("@modules/contacts/routes/contacts.routes"),
  controllers: require("@modules/contacts/controllers/index"),
  services: require("@modules/contacts/services/index"),
  repositories: require("@modules/contacts/repositories/index"),
  validations: require("@modules/contacts/validations/index"),
  dto: require("@modules/contacts/dto/index"),
  constants: require("@modules/contacts/constants/index"),
  utils: require("@modules/contacts/utils/index"),
  events: require("@modules/contacts/events/index"),
};

