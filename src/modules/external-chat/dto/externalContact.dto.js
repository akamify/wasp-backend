function mapAttributes(attributes) {
  if (!attributes) return {};
  if (attributes instanceof Map) return Object.fromEntries(attributes.entries());
  if (typeof attributes === "object") return { ...attributes };
  return {};
}

function toExternalContactDto(contactDoc) {
  if (!contactDoc) return null;
  const c = contactDoc.toObject ? contactDoc.toObject() : contactDoc;

  return {
    id: String(c._id || ""),
    phone: String(c.phone || ""),
    name: c.name || "",
    email: c.email || "",
    company: c.company || "",
    tags: Array.isArray(c.tags) ? c.tags.map((tag) => String(tag || "")).filter(Boolean) : [],
    attributes: mapAttributes(c.attributes),
    lastMessagePreview: c.lastMessagePreview || "",
    lastInboundAt: c.lastInboundAt || null,
    lastOutboundAt: c.lastOutboundAt || null,
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
  };
}

module.exports = { toExternalContactDto };
