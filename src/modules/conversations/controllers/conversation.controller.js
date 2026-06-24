const { Conversation } = require("@infra/database/Conversation");
const { Contact } = require("@infra/database/Contact");
const { Message } = require("@infra/database/Message");
const { normalizePhone } = require("@shared/services/contactService");
const { markConversationRead } = require("@shared/services/conversationService");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { markMessageAsRead } = require("@shared/utils/whatsappSender");
const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { windowState } = require("../services/customerServiceWindow.service");

function withServiceWindow(conversation, now = new Date()) {
  const plain = conversation?.toObject ? conversation.toObject() : conversation || {};
  return { ...plain, ...windowState(plain, now) };
}

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

  const interactiveTitle =
    payload.interactive?.button_reply?.title ||
    payload.interactive?.list_reply?.title ||
    "";
  const text = String(
    interactiveTitle || message.text || message.display?.body || fallback || ""
  ).trim();
  if (text && !/^\[(image|video|document|contacts?)\]$/i.test(text)) return text.slice(0, 160);

  if (payload.image?.id || payload.image?.link) return "Image";
  if (payload.video?.id || payload.video?.link) return "Video";
  if (payload.audio?.id || payload.audio?.link) return "Audio";
  if (payload.document?.id || payload.document?.link) return String(payload.document?.filename || "Document").slice(0, 160);
  if (Array.isArray(payload.contacts) && payload.contacts.length) return "Contact";

  return text.slice(0, 160);
}

function mapConversationListItemForPublic(item) {
  const serviceWindow = windowState(item);
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
    ...serviceWindow,
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
  const conversationFilter = { workspaceId: req.workspace.id, wabaId: scope.wabaId };
  if (String(req.query.filter || "").toLowerCase() === "unread") conversationFilter.unreadCount = { $gt: 0 };
  if (String(req.query.filter || "").toLowerCase() === "read") {
    conversationFilter.$or = [{ unreadCount: 0 }, { unreadCount: { $exists: false } }];
  }
  const [conversations, unreadRows] = await Promise.all([
    Conversation.find(conversationFilter).sort({ lastMessageAt: -1 }).limit(limit),
    Conversation.find({ workspaceId: req.workspace.id, wabaId: scope.wabaId, unreadCount: { $gt: 0 } }).select("unreadCount").lean(),
  ]);
  const totalUnread = unreadRows.reduce((total, conversation) => total + Number(conversation.unreadCount || 0), 0);

  let items = await attachContacts(req.workspace.id, scope.wabaId, conversations);
  const phones = items.map((item) => item.phone).filter(Boolean);

  if (phones.length) {
    const latestRows = await Message.aggregate([
      { $match: { workspaceId: conversations[0].workspaceId, wabaId: scope.wabaId, phone: { $in: phones } } },
      {
        $addFields: {
          effectiveSortAt: {
            $ifNull: [
              "$sortAt",
              {
                $ifNull: [
                  "$receivedAt",
                  { $ifNull: ["$sentAt", "$createdAt"] },
                ],
              },
            ],
          },
        },
      },
      { $sort: { effectiveSortAt: -1, createdAt: -1, _id: -1 } },
      {
        $group: {
          _id: "$phone",
          latest: {
            $first: {
              phone: "$phone",
              text: "$text",
              payload: "$payload",
              display: "$display",
              direction: "$direction",
              status: "$status",
              createdAt: "$createdAt",
              sortAt: "$effectiveSortAt",
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
          lastMessageAt: latest.sortAt || latest.createdAt || item.lastMessageAt,
          lastMessagePreview: previewFromMessage(latest, item.lastMessagePreview),
          lastMessage: previewFromMessage(latest, item.lastMessagePreview),
          lastMessageDirection: latest.direction || item.lastMessageDirection || null,
          lastMessageStatus: latest.status || item.lastMessageStatus || null,
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
          totalUnread,
        },
      },
    });
  }

  const responseNow = new Date();
  items = items.map((item) => withServiceWindow(item, responseNow));

  return res.json({ success: true, conversations: items, totalUnread });
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

  const resolvedConversation = withServiceWindow(conversation || {
    phone,
    unreadCount: 0,
    lastMessagePreview: "",
    lastMessageAt: null,
  });

  res.json({
    success: true,
    conversation: resolvedConversation,
    contact: contact || null,
  });
}

async function readConversation(req, res) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

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

  const localReadAt = new Date();
  if (pendingInbound.length) {
    await Message.updateMany(
      { _id: { $in: pendingInbound.map((message) => message._id) } },
      { $set: { status: "read", "statusTimestamps.readByBusinessAt": localReadAt } }
    );
  }
  const conversation = await markConversationRead({ userId: req.workspace.id, wabaId: scope.wabaId, phone });

  // Provider receipts are best-effort and do not gate local unread state.
  try {
    const creds = await getCredentialsForUser(req.workspace.id);
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

