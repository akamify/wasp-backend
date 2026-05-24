const { Conversation } = require("@infra/database/Conversation");
const { Contact } = require("@infra/database/Contact");
const { Message } = require("@infra/database/Message");
const { HttpError } = require("@shared/utils/httpError");
const { normalizePhone } = require("@shared/services/contactService");
const { markConversationEmployeeRead } = require("@shared/services/conversationService");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { markMessageAsRead } = require("@shared/utils/whatsappSender");

async function attachContacts(workspaceId, conversations) {
  const phones = Array.from(new Set(conversations.map((item) => item.phone).filter(Boolean)));
  const contacts = await Contact.find({ workspaceId, phone: { $in: phones } }).select("_id phone name company tags");
  const contactMap = new Map(contacts.map((contact) => [contact.phone, contact]));

  return conversations.map((conversation) => {
    const contact = contactMap.get(conversation.phone);
    return {
      ...conversation.toObject(),
      contact: contact
        ? { _id: contact._id, phone: contact.phone, name: contact.name, company: contact.company, tags: contact.tags || [] }
        : null,
    };
  });
}

function previewFromMessage(message, fallback = "") {
  if (!message) return fallback || "";
  const payload = message.payload || {};
  if (payload.deleted) return "Message deleted";
  const templateName = payload.template?.name || message.display?.templateName;
  if (templateName) return `Template: ${String(templateName).trim()}`.slice(0, 160);
  const text = String(message.text || message.display?.body || fallback || "").trim();
  if (text && !/^\[(image|video|document|contacts?)\]$/i.test(text)) return text.slice(0, 160);
  if (payload.image?.id || payload.image?.link) return "Image";
  if (payload.video?.id || payload.video?.link) return "Video";
  if (payload.audio?.id || payload.audio?.link) return "Audio";
  if (payload.document?.id || payload.document?.link) return String(payload.document?.filename || "Document").slice(0, 160);
  if (Array.isArray(payload.contacts) && payload.contacts.length) return "Contact";
  return text.slice(0, 160);
}

async function listEmployeeConversations(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const conversations = await Conversation.find({
    workspaceId: req.workspace.id,
    assignedEmployeeId: req.employee.id,
  })
    .sort({ lastMessageAt: -1 })
    .limit(limit);

  let items = await attachContacts(req.workspace.id, conversations);
  const phones = items.map((item) => item.phone).filter(Boolean);

  if (phones.length) {
    const latestRows = await Message.aggregate([
      { $match: { workspaceId: conversations[0].workspaceId, phone: { $in: phones } } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: "$phone", latest: { $first: { phone: "$phone", text: "$text", payload: "$payload", display: "$display", createdAt: "$createdAt" } } } },
    ]);
    const latestByPhone = new Map(latestRows.map((row) => [row._id, row.latest]));
    items = items
      .map((item) => {
        const latest = latestByPhone.get(item.phone);
        if (!latest) return item;
        return {
          ...item,
          lastMessageAt: latest.createdAt || item.lastMessageAt,
          lastMessagePreview: previewFromMessage(latest, item.lastMessagePreview),
        };
      })
      .sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
  }

  if (req.query.search) {
    const query = String(req.query.search).trim().toLowerCase();
    items = items.filter((item) =>
      [item.phone, item.lastMessagePreview, item.contact?.name, item.contact?.company]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query))
    );
  }

  res.json({ success: true, conversations: items });
}

async function getEmployeeConversation(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const [conversation, contact] = await Promise.all([
    Conversation.findOne({ workspaceId: req.workspace.id, phone, assignedEmployeeId: req.employee.id }),
    Contact.findOne({ workspaceId: req.workspace.id, phone }).select("_id phone name company email language notes tags"),
  ]);

  if (!conversation) throw new HttpError(403, "Forbidden");

  res.json({
    success: true,
    conversation: conversation || { phone, unreadCount: 0, lastMessagePreview: "", lastMessageAt: null },
    contact: contact || null,
  });
}

async function readEmployeeConversation(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  // Best-effort Meta read receipts (same behavior as owner inbox).
  try {
    const creds = await getCredentialsForUser(req.workspace.id);
    const pendingInbound = await Message.find({
      workspaceId: req.workspace.id,
      phone,
      direction: "inbound",
      status: "received",
      whatsappMessageId: { $type: "string" },
      readReceiptSentAt: null,
    })
      .sort({ createdAt: 1 })
      .limit(100)
      .select("_id whatsappMessageId");

    for (const msg of pendingInbound) {
      try {
        await markMessageAsRead({
          accessToken: creds.accessToken,
          phoneNumberId: creds.phoneNumberId,
          messageId: String(msg.whatsappMessageId),
          graphApiVersion: creds.graphApiVersion,
        });
        await Message.updateOne(
          { _id: msg._id },
          { $set: { readReceiptSentAt: new Date(), "statusTimestamps.readByBusinessAt": new Date() } }
        );
      } catch {}
    }
  } catch {}

  const conversation = await markConversationEmployeeRead({
    workspaceId: req.workspace.id,
    phone,
    employeeId: req.employee.id,
  });

  res.json({ success: true, conversation: conversation || null, phone });
}

module.exports = {
  listEmployeeConversations,
  getEmployeeConversation,
  readEmployeeConversation,
};

