const { Conversation } = require("../models/Conversation");
const { Contact } = require("../models/Contact");
const { Message } = require("../models/Message");
const { normalizePhone } = require("../services/contactService");
const { markConversationRead } = require("../services/conversationService");
const { getCredentialsForUser } = require("../services/credentialsService");
const { markMessageAsRead } = require("../utils/whatsappSender");
const { HttpError } = require("../utils/httpError");

async function attachContacts(userId, conversations) {
  const phones = Array.from(new Set(conversations.map((item) => item.phone).filter(Boolean)));
  const contacts = await Contact.find({ workspaceId: userId, phone: { $in: phones } }).select(
    "_id phone name company tags"
  );
  const contactMap = new Map(contacts.map((contact) => [contact.phone, contact]));

  return conversations.map((conversation) => {
    const contact = contactMap.get(conversation.phone);
    return {
      ...conversation.toObject(),
      contact: contact
        ? {
            _id: contact._id,
            phone: contact.phone,
            name: contact.name,
            company: contact.company,
            tags: contact.tags || [],
          }
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
  if (payload.document?.id || payload.document?.link) return String(payload.document?.filename || "Document").slice(0, 160);
  if (Array.isArray(payload.contacts) && payload.contacts.length) return "Contact";

  return text.slice(0, 160);
}

async function listConversations(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const conversations = await Conversation.find({ workspaceId: req.workspace.id })
    .sort({ lastMessageAt: -1 })
    .limit(limit);

  let items = await attachContacts(req.workspace.id, conversations);
  const phones = items.map((item) => item.phone).filter(Boolean);

  if (phones.length) {
    const latestRows = await Message.aggregate([
      { $match: { workspaceId: conversations[0].workspaceId, phone: { $in: phones } } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: "$phone",
          latest: {
            $first: {
              phone: "$phone",
              text: "$text",
              payload: "$payload",
              display: "$display",
              createdAt: "$createdAt",
            },
          },
        },
      },
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

async function getConversation(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const [conversation, contact] = await Promise.all([
    Conversation.findOne({ workspaceId: req.workspace.id, phone }),
    Contact.findOne({ workspaceId: req.workspace.id, phone }).select(
      "_id phone name company email notes tags"
    ),
  ]);

  res.json({
    success: true,
    conversation: conversation || {
      phone,
      unreadCount: 0,
      lastMessagePreview: "",
      lastMessageAt: null,
    },
    contact: contact || null,
  });
}

async function readConversation(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  // Send read receipts only when agent opens/reads chat (controlled seen behavior).
  // Best-effort: conversation read should still succeed even if Meta call fails.
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
          {
            $set: {
              readReceiptSentAt: new Date(),
              "statusTimestamps.readByBusinessAt": new Date(),
            },
          }
        );
      } catch {
        // Ignore per-message read receipt failures and continue.
      }
    }
  } catch {
    // Ignore credential/Meta issues; keeping read endpoint resilient.
  }

  const conversation = await markConversationRead({ userId: req.workspace.id, phone });
  res.json({ success: true, conversation: conversation || null, phone });
}

module.exports = { listConversations, getConversation, readConversation };
