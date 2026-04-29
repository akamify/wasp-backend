const { Conversation } = require("../models/Conversation");
const { normalizePhone } = require("./contactService");

async function touchConversation({
  userId,
  phone,
  lastMessageAt,
  lastMessagePreview,
  incrementUnread = false,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const update = {
    $set: {
      lastMessageAt: lastMessageAt || new Date(),
      ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
    },
  };
  if (incrementUnread) update.$inc = { unreadCount: 1 };

  return Conversation.findOneAndUpdate({ workspaceId: userId, phone: normalizedPhone }, update, {
    upsert: true,
    returnDocument: "after",
    setDefaultsOnInsert: true,
  });
}

async function markConversationRead({ userId, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  return Conversation.findOneAndUpdate(
    { workspaceId: userId, phone: normalizedPhone },
    { $set: { unreadCount: 0 } },
    { returnDocument: "after" }
  );
}

module.exports = { touchConversation, markConversationRead };
