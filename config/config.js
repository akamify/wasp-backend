// Legacy config export (kept for compatibility). New code should prefer `config/env.js`.
require("dotenv").config();

const { metaGraphVersion } = require("./env");

module.exports = {
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN,
    phoneNumberId: process.env.PHONE_NUMBER_ID,
    businessAccountId: process.env.BUSINESS_ACCOUNT_ID,
    graphApiVersion: metaGraphVersion,
    apiUrl: `https://graph.facebook.com/${metaGraphVersion}/${process.env.PHONE_NUMBER_ID}/messages`,
  },
};
