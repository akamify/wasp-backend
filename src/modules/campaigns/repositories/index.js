const campaignsRepository = require("@modules/campaigns/repositories/campaigns.repository");
const messagesRepository = require("@modules/campaigns/repositories/messages.repository");
const templatesRepository = require("@modules/campaigns/repositories/templates.repository");
const transactionsRepository = require("@modules/campaigns/repositories/transactions.repository");
const contactsRepository = require("@modules/campaigns/repositories/contacts.repository");

module.exports = {
    campaignsRepository,
    messagesRepository,
    templatesRepository,
    transactionsRepository,
    contactsRepository,
};
