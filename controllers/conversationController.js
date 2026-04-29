const { Conversation } = require("../models/Conversation");
const { Contact } = require("../models/Contact");
const { normalizePhone } = require("../services/contactService");
const { markConversationRead } = require("../services/conversationService");
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

async function listConversations(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const conversations = await Conversation.find({ workspaceId: req.workspace.id })
    .sort({ lastMessageAt: -1 })
    .limit(limit);

  let items = await attachContacts(req.workspace.id, conversations);

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

  const conversation = await markConversationRead({ userId: req.workspace.id, phone });
  res.json({ success: true, conversation: conversation || null, phone });
}

module.exports = { listConversations, getConversation, readConversation };
