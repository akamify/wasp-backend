const { Conversation } = require("@infra/database/Conversation");
const mongoose = require("mongoose");
const { normalizePhone } = require("@shared/services/contactService");
const { publishWorkspaceEvent, publishToWorkspace } = require("@shared/services/realtimeService");

async function totalUnreadForWorkspace(workspaceId) {
  const rows = await Conversation.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) } },
    { $group: { _id: null, total: { $sum: "$unreadCount" } } },
  ]);
  return Number(rows[0]?.total || 0);
}

async function touchConversation({
  userId,
  wabaId,
  phoneNumberId,
  phone,
  lastMessageAt,
  lastInboundAt,
  lastMessagePreview,
  lastMessageDirection,
  lastMessageStatus,
  incrementUnread = false,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;
  const resolvedDirection = lastMessageDirection || (incrementUnread ? "inbound" : lastMessagePreview !== undefined ? "outbound" : null);
  const resolvedStatus = lastMessageStatus || (resolvedDirection === "inbound" ? "received" : resolvedDirection === "outbound" ? "sent" : null);

  const update = {
    $set: {
      lastMessageAt: lastMessageAt || new Date(),
      ...(lastInboundAt ? { lastInboundAt } : {}),
      ...(lastInboundAt ? { lastCustomerMessageAt: lastInboundAt } : {}),
      ...(lastMessagePreview !== undefined ? { lastMessagePreview } : {}),
      ...(lastMessagePreview !== undefined ? { lastMessage: lastMessagePreview } : {}),
      ...(resolvedDirection ? { lastMessageDirection: resolvedDirection } : {}),
      ...(resolvedStatus ? { lastMessageStatus: resolvedStatus } : {}),
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
    publishToWorkspace(userId, "conversation:update", { conversation: conversation.toObject() });
    if (incrementUnread) {
      const totalUnread = await totalUnreadForWorkspace(userId);
      publishToWorkspace(userId, "unread:update", {
        conversationId: String(conversation._id),
        customerPhone: normalizedPhone,
        unreadCount: Number(conversation.unreadCount || 0),
        totalUnread,
      });
    }
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
    { $set: { unreadCount: 0, ownerUnreadCount: 0, lastReadAt: new Date() } },
    { returnDocument: "after" }
  );

  if (conversation?._id) {
    publishToWorkspace(userId, "conversation:update", { conversation: conversation.toObject() });
    publishToWorkspace(userId, "unread:update", {
      conversationId: String(conversation._id),
      customerPhone: normalizedPhone,
      unreadCount: 0,
      totalUnread: await totalUnreadForWorkspace(userId),
    });
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

