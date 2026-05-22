const { ProcessedPaymentEvent } = require("@infra/database/ProcessedPaymentEvent");

async function createProcessedEvent(payload) {
  return ProcessedPaymentEvent.create(payload);
}

module.exports = { createProcessedEvent };

