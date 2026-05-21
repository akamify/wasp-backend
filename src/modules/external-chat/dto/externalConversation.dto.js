function toExternalConversationDto(conversationDoc) {
  if (!conversationDoc) return null;
  const c = conversationDoc.toObject ? conversationDoc.toObject() : conversationDoc;

  return {
    id: String(c._id || ""),
    phone: String(c.phone || ""),
    lastMessage: {
      preview: String(c.lastMessagePreview || ""),
      at: c.lastMessageAt || null,
    },
    unreadCount: Number(c.unreadCount || 0),
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
  };
}

module.exports = { toExternalConversationDto };
