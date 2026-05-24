const { BillingCheckoutIntent } = require("@infra/database/BillingCheckoutIntent");

async function createIntent(payload) {
  return BillingCheckoutIntent.create(payload);
}

module.exports = { createIntent };

