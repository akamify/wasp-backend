const { Invoice } = require("@infra/database/Invoice");

async function createInvoice(payload) {
  return Invoice.create(payload);
}

module.exports = { createInvoice };

