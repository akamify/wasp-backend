const { Conversation } = require("@infra/database/Conversation");
const { Contact } = require("@infra/database/Contact");
const { Message } = require("@infra/database/Message");
const { normalizePhone } = require("@shared/services/contactService");
const { markConversationRead } = require("@shared/services/conversationService");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { markMessageAsRead } = require("@shared/utils/whatsappSender");
const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

async function attachContacts(userId, wabaId, conversations) {
  const phones = Array.from(new Set(conversations.map((item) => item.phone).filter(Boolean)));
  const contacts = await Contact.find({ workspaceId: userId, wabaId, phone: { $in: phones } }).select(
    "_id phone name company tags attributes"
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
          attributes: contact.attributes || {},
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
  if (payload.audio?.id || payload.audio?.link) return "Audio";
  if (payload.document?.id || payload.document?.link) return String(payload.document?.filename || "Document").slice(0, 160);
  if (Array.isArray(payload.contacts) && payload.contacts.length) return "Contact";

  return text.slice(0, 160);
}

function mapConversationListItemForPublic(item) {
  const phone = String(item?.phone || "").trim();
  const contactName = String(item?.contact?.name || "").trim();
  return {
    id: String(item?._id || ""),
    phone,
    displayName: contactName || phone,
    lastMessage: {
      preview: String(item?.lastMessagePreview || ""),
      at: item?.lastMessageAt || null,
    },
    unreadCount: Number(item?.unreadCount || 0),
    lead: {
      status: item?.leadStatus || "UNASSIGNED",
      assignedEmployeeId: item?.assignedEmployeeId ? String(item.assignedEmployeeId) : null,
    },
    contact: item?.contact
      ? {
        id: String(item.contact?._id || ""),
        phone: String(item.contact?.phone || ""),
        name: String(item.contact?.name || ""),
        company: String(item.contact?.company || ""),
        tags: Array.isArray(item.contact?.tags) ? item.contact.tags : [],
        attributes: item.contact?.attributes || {},
      }
      : null,
    createdAt: item?.createdAt || null,
    updatedAt: item?.updatedAt || null,
  };
}

async function listConversations(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const conversations = await Conversation.find({ workspaceId: req.workspace.id, wabaId: scope.wabaId })
    .sort({ lastMessageAt: -1 })
    .limit(limit);

  let items = await attachContacts(req.workspace.id, scope.wabaId, conversations);
  const phones = items.map((item) => item.phone).filter(Boolean);

  if (phones.length) {
    const latestRows = await Message.aggregate([
      { $match: { workspaceId: conversations[0].workspaceId, wabaId: scope.wabaId, phone: { $in: phones } } },
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

  if (req.auth?.isApiKey) {
    return res.json({
      success: true,
      message: "Conversations fetched successfully.",
      data: {
        items: items.map(mapConversationListItemForPublic),
        pagination: {
          limit,
          total: items.length,
          hasNextPage: items.length >= limit,
        },
      },
    });
  }

  return res.json({ success: true, conversations: items });
}

async function getConversation(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");

  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const [conversation, contact] = await Promise.all([
    Conversation.findOne({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone }),
    Contact.findOne({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone }).select(
      "_id phone name company email language notes tags attributes"
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
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  // Send read receipts only when agent opens/reads chat (controlled seen behavior).
  // Best-effort: conversation read should still succeed even if Meta call fails.
  try {
    const creds = await getCredentialsForUser(req.workspace.id);
    const pendingInbound = await Message.find({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
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

  const conversation = await markConversationRead({ userId: req.workspace.id, wabaId: scope.wabaId, phone });
  res.json({ success: true, conversation: conversation || null, phone });
}

async function clearConversation(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  // Delete messages for this conversation but keep the Contact record intact.
  await Message.deleteMany({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone });

  // Reset or remove the Conversation entry so it no longer shows recent activity.
  await Conversation.updateOne(
    { workspaceId: req.workspace.id, wabaId: scope.wabaId, phone },
    { $set: { lastMessageAt: null, lastMessagePreview: "", unreadCount: 0 } }
  );

  res.json({ success: true, phone });
}

module.exports = { listConversations, getConversation, readConversation, clearConversation };

