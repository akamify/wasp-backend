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

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapStatusTimestamps(statusTimestamps) {
  const s = statusTimestamps || {};
  return {
    acceptedAt: toIsoOrNull(s.acceptedAt),
    sentAt: toIsoOrNull(s.sentAt),
    deliveredAt: toIsoOrNull(s.deliveredAt),
    readAt: toIsoOrNull(s.readAt),
    failedAt: toIsoOrNull(s.failedAt),
    receivedAt: toIsoOrNull(s.receivedAt),
    readByBusinessAt: toIsoOrNull(s.readByBusinessAt),
  };
}

function mapStatusHistory(statusHistory) {
  if (!Array.isArray(statusHistory)) return [];
  return statusHistory.map((item) => ({
    status: String(item?.status || ""),
    timestamp: toIsoOrNull(item?.timestamp),
    error: item?.error || null,
  }));
}

function toExternalMessageDto(messageDoc) {
  if (!messageDoc) return null;
  const m = messageDoc.toObject ? messageDoc.toObject() : messageDoc;

  return {
    id: String(m._id || ""),
    phone: String(m.phone || ""),
    direction: String(m.direction || ""),
    status: String(m.status || ""),
    statusTimestamps: mapStatusTimestamps(m.statusTimestamps),
    statusHistory: mapStatusHistory(m.statusHistory),
    whatsappMessageId: m.whatsappMessageId ? String(m.whatsappMessageId) : null,
    text: typeof m.text === "string" ? m.text : "",
    media: mapMessageMedia(m.payload),
    error: m.error || null,
    sender: mapSender(m.sentBy),
    createdAt: m.createdAt || null,
    updatedAt: m.updatedAt || null,
  };
}

module.exports = { toExternalMessageDto };
