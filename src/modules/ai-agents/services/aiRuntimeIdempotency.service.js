const { hashIdempotencyParts } = require("@modules/billing/utils/idempotency");

function buildExecutionKey({ workspaceId, inboundMessageId, inboundWhatsappMessageId, phone }) {
  return hashIdempotencyParts([
    "ai-runtime",
    workspaceId,
    inboundMessageId || "",
    inboundWhatsappMessageId || "",
    phone || "",
  ]);
}

function buildOutboundReplyIdempotencyKey(executionKey) {
  return hashIdempotencyParts(["ai-runtime-reply", executionKey || ""]);
}

module.exports = {
  buildExecutionKey,
  buildOutboundReplyIdempotencyKey,
};
