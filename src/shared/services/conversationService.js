const { Conversation } = require("@infra/database/Conversation");
const { normalizePhone } = require("@shared/services/contactService");
const { publishWorkspaceEvent } = require("@shared/services/realtimeService");

async function touchConversation({
  userId,
  wabaId,
  phoneNumberId,
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
      wabaId,
      phoneNumberId: phoneNumberId || null,
    },
  };
  if (incrementUnread) update.$inc = { unreadCount: 1, ownerUnreadCount: 1 };

  const conversation = await Conversation.findOneAndUpdate({ workspaceId: userId, wabaId, phone: normalizedPhone }, update, {
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

  if (conversation?._id) {
    publishWorkspaceEvent(userId, {
      type: "conversation.updated",
      conversationId: String(conversation._id),
      phone: normalizedPhone,
    });
  }

  return conversation;
}

async function markConversationRead({ userId, wabaId, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const conversation = await Conversation.findOneAndUpdate(
    { workspaceId: userId, wabaId, phone: normalizedPhone },
    { $set: { unreadCount: 0, ownerUnreadCount: 0 } },
    { returnDocument: "after" }
  );

  if (conversation?._id) {
    publishWorkspaceEvent(userId, {
      type: "conversation.updated",
      conversationId: String(conversation._id),
      phone: normalizedPhone,
    });
  }

  return conversation;
}

async function markConversationEmployeeRead({ workspaceId, wabaId, phone, employeeId }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const conversation = await Conversation.findOneAndUpdate(
    { workspaceId, wabaId, phone: normalizedPhone, assignedEmployeeId: employeeId },
    { $set: { employeeUnreadCount: 0 } },
    { returnDocument: "after" }
  );

  if (conversation?._id) {
    publishWorkspaceEvent(workspaceId, {
      type: "conversation.updated",
      conversationId: String(conversation._id),
      phone: normalizedPhone,
    });
  }

  return conversation;
}

module.exports = { touchConversation, markConversationRead, markConversationEmployeeRead };

