const { ConversationEvent } = require("@infra/database/ConversationEvent");

async function writeConversationEvent({
  workspaceId,
  conversationId,
  phone,
  type,
  actor,
  payload,
}) {
  return ConversationEvent.create({
    workspaceId,
    conversationId,
    phone,
    type,
    actor,
    payload: payload || null,
  });
}

module.exports = { writeConversationEvent };

