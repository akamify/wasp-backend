const { normalizePhone } = require("@shared/services/contactService");

const MEDIA_TYPES = new Set(["image", "document", "audio", "video"]);

function receivedAtFromTimestamp(timestamp) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

function normalizeMessageType(message) {
  const type = String(message?.type || "").trim().toLowerCase();
  const interactiveType = String(message?.interactive?.type || "")
    .trim()
    .toLowerCase();

  if (type === "text") return "text";
  if (
    (type === "interactive" && interactiveType === "button_reply") ||
    type === "button"
  ) {
    return "button_reply";
  }
  if (type === "interactive" && interactiveType === "list_reply") {
    return "list_reply";
  }
  if (MEDIA_TYPES.has(type)) return type;
  return "unknown";
}

function normalizeButtonReply(message) {
  const reply =
    message?.interactive?.button_reply ||
    (message?.type === "button" ? message.button : null);
  if (!reply) return null;
  return {
    id: String(reply.id || reply.payload || "").trim(),
    title: String(reply.title || reply.text || "").trim(),
  };
}

function normalizeListReply(message) {
  const reply = message?.interactive?.list_reply;
  if (!reply) return null;
  return {
    id: String(reply.id || "").trim(),
    title: String(reply.title || "").trim(),
    description: String(reply.description || "").trim(),
  };
}

function normalizeMessageContext(message) {
  const context = message?.context;
  if (!context) return null;
  const id = String(context?.id || "").trim();
  const from = normalizePhone(context?.from);
  if (!id && !from) return null;
  return {
    id,
    from,
    forwarded: Boolean(context?.forwarded),
    frequentlyForwarded: Boolean(context?.frequently_forwarded),
  };
}

function normalizeWhatsAppWebhookMessages({ value, workspaceId = null }) {
  const phoneNumberId = String(
    value?.metadata?.phone_number_id || ""
  ).trim();
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  const profileNameByPhone = new Map(
    contacts
      .map((contact) => {
        const phone = normalizePhone(contact?.wa_id);
        const profileName = String(contact?.profile?.name || "").trim();
        return phone ? [phone, profileName] : null;
      })
      .filter(Boolean)
  );

  return (Array.isArray(value?.messages) ? value.messages : [])
    .map((message) => {
      const from = normalizePhone(message?.from);
      const whatsappMessageId = String(message?.id || "").trim();
      if (!from || !whatsappMessageId) return null;

      const type = normalizeMessageType(message);
      return {
        workspaceId: workspaceId ? String(workspaceId) : null,
        phoneNumberId,
        from,
        whatsappMessageId,
        type,
        text:
          type === "text"
            ? String(message?.text?.body || "")
            : null,
        buttonReply:
          type === "button_reply" ? normalizeButtonReply(message) : null,
        listReply:
          type === "list_reply" ? normalizeListReply(message) : null,
        context: normalizeMessageContext(message),
        rawPayload: message,
        profileName: profileNameByPhone.get(from) || null,
        receivedAt: receivedAtFromTimestamp(message?.timestamp),
      };
    })
    .filter(Boolean);
}

module.exports = {
  normalizeWhatsAppWebhookMessages,
};
