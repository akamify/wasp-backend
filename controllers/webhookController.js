const { metaWebhookVerifyToken } = require("../config/env");
const { findTenantByPhoneNumberId } = require("../services/credentialsService");
const { Message } = require("../models/Message");
const { touchConversation } = require("../services/conversationService");
const { normalizePhone, touchContactFromMessage } = require("../services/contactService");

function asDateFromSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return new Date();
  return new Date(n * 1000);
}

function normalizeStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "sent") return "sent";
  if (s === "delivered") return "delivered";
  if (s === "read") return "read";
  if (s === "failed") return "failed";
  return "sent";
}

async function verify(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === metaWebhookVerifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
}

async function receive(req, res) {
  const body = req.body;
  if (!body) return res.sendStatus(400);

  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const tenant = await findTenantByPhoneNumberId(phoneNumberId);
      if (!tenant) continue;
      const workspaceId = tenant.workspaceId;

      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const s of statuses) {
        const waId = s.id;
        if (!waId) continue;

        const newStatus = normalizeStatus(s.status);
        const ts = asDateFromSeconds(s.timestamp);
        const phone = s.recipient_id ? normalizePhone(s.recipient_id) : undefined;

        const set = {
          status: newStatus,
          ...(phone ? { phone } : {}),
          ...(newStatus === "failed" && s.errors ? { error: s.errors } : {}),
        };

        if (newStatus === "sent") set["statusTimestamps.sentAt"] = ts;
        if (newStatus === "delivered") set["statusTimestamps.deliveredAt"] = ts;
        if (newStatus === "read") set["statusTimestamps.readAt"] = ts;
        if (newStatus === "failed") set["statusTimestamps.failedAt"] = ts;

        await Message.findOneAndUpdate(
          { workspaceId, whatsappMessageId: waId },
          {
            $set: set,
            $setOnInsert: {
              workspaceId,
              phone: phone || "unknown",
              direction: "outbound",
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const m of messages) {
        const waId = m.id;
        const from = normalizePhone(m.from);
        if (!waId || !from) continue;

        const ts = asDateFromSeconds(m.timestamp);
        const text = m.text?.body || (m.type ? `[${m.type}]` : "");

        await Message.findOneAndUpdate(
          { workspaceId, whatsappMessageId: waId },
          {
            $set: {
              workspaceId,
              phone: from,
              direction: "inbound",
              status: "received",
              "statusTimestamps.receivedAt": ts,
              text,
            },
            $setOnInsert: { createdAt: ts },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        await touchConversation({
          userId: workspaceId,
          phone: from,
          lastMessageAt: ts,
          lastMessagePreview: text.slice(0, 160),
          incrementUnread: true,
        });
        await touchContactFromMessage({
          userId: workspaceId,
          phone: from,
          direction: "inbound",
          preview: text.slice(0, 160),
          occurredAt: ts,
        });
      }
    }
  }

  return res.sendStatus(200);
}

module.exports = { verify, receive };
