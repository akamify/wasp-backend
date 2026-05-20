const { Conversation } = require("@infra/database/Conversation");
const { normalizePhone } = require("@shared/services/contactService");

async function touchConversation({
  userId,
  phone,
  lastMessageAt,
  lastInboundAt,
  lastMessagePreview,
  incrementUnread = false,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const update = {
    $set: {
      lastMessageAt: lastMessageAt || new Date(),
      ...(lastInboundAt ? { lastInboundAt } : {}),
      ...(lastInboundAt ? { lastCustomerMessageAt: lastInboundAt } : {}),
      ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
      normalizedPhone,
    },
  };
  if (incrementUnread) update.$inc = { unreadCount: 1, ownerUnreadCount: 1 };

  const conversation = await Conversation.findOneAndUpdate({ workspaceId: userId, phone: normalizedPhone }, update, {
    upsert: true,
    returnDocument: "after",
    setDefaultsOnInsert: true,
  });

  if (incrementUnread && conversation?.assignedEmployeeId) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $inc: { employeeUnreadCount: 1 } }
    );
    // Keep returned snapshot consistent-ish for immediate callers.
    conversation.employeeUnreadCount = Number(conversation.employeeUnreadCount || 0) + 1;
  }

  return conversation;
}

async function markConversationRead({ userId, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  return Conversation.findOneAndUpdate(
    { workspaceId: userId, phone: normalizedPhone },
    { $set: { unreadCount: 0, ownerUnreadCount: 0 } },
    { returnDocument: "after" }
  );
}

async function markConversationEmployeeRead({ workspaceId, phone, employeeId }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  return Conversation.findOneAndUpdate(
    { workspaceId, phone: normalizedPhone, assignedEmployeeId: employeeId },
    { $set: { employeeUnreadCount: 0 } },
    { returnDocument: "after" }
  );
}

module.exports = { touchConversation, markConversationRead, markConversationEmployeeRead };

