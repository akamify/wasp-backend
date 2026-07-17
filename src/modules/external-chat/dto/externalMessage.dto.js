function mapSender(sentBy) {
  return {
    kind: String(sentBy?.kind || "system"),
  };
}

function mapMessageMedia(payload) {
  const type = String(payload?.type || "").toLowerCase();
  if (!type) return null;
  if (!["image", "video", "audio", "document"].includes(type)) return null;

  const mediaByType = payload?.[type] || {};
  return {
    type,
    caption: String(mediaByType?.caption || ""),
    filename: String(mediaByType?.filename || ""),
  };
}

function toExternalMessageDto(messageDoc) {
  if (!messageDoc) return null;
  const m = messageDoc.toObject ? messageDoc.toObject() : messageDoc;

  return {
    id: String(m._id || ""),
    phone: String(m.phone || ""),
    direction: String(m.direction || ""),
    status: String(m.status || ""),
    whatsappMessageId: m.whatsappMessageId ? String(m.whatsappMessageId) : null,
    text: typeof m.text === "string" ? m.text : "",
    media: mapMessageMedia(m.payload),
    sender: mapSender(m.sentBy),
    createdAt: m.createdAt || null,
    updatedAt: m.updatedAt || null,
  };
}

module.exports = { toExternalMessageDto };
