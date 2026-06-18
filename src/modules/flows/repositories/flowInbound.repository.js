const { InboundMessage } = require("@infra/database/InboundMessage");

async function createInboundMessage(data) {
  return InboundMessage.create(data);
}

async function markInboundMessageProcessed({
  workspaceId,
  inboundMessageId,
  contactId,
  processedAt,
}) {
  return InboundMessage.findOneAndUpdate(
    { _id: inboundMessageId, workspaceId },
    {
      $set: {
        contactId,
        processingStatus: "processed",
        processedAt,
        error: null,
      },
    },
    { returnDocument: "after", runValidators: true }
  );
}

async function markInboundMessageFailed({
  workspaceId,
  inboundMessageId,
  error,
  processedAt,
}) {
  return InboundMessage.findOneAndUpdate(
    { _id: inboundMessageId, workspaceId },
    {
      $set: {
        processingStatus: "failed",
        processedAt,
        error,
      },
    },
    { returnDocument: "after", runValidators: true }
  );
}

module.exports = {
  createInboundMessage,
  markInboundMessageProcessed,
  markInboundMessageFailed,
};
