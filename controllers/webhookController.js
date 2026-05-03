const { metaWebhookVerifyToken } = require("../config/env");
const { findTenantByPhoneNumberId, findTenantByWabaId } = require("../services/credentialsService");
const { Message } = require("../models/Message");
const { touchConversation } = require("../services/conversationService");
const { normalizePhone, touchContactFromMessage } = require("../services/contactService");
const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");

const WEBHOOK_DEBUG_LIMIT = 40;
const webhookDebugEvents = [];

function pushWebhookDebugEvent(event) {
  webhookDebugEvents.unshift({
    at: new Date().toISOString(),
    ...event,
  });
  if (webhookDebugEvents.length > WEBHOOK_DEBUG_LIMIT) {
    webhookDebugEvents.length = WEBHOOK_DEBUG_LIMIT;
  }
}

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
    if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
      // eslint-disable-next-line no-console
      console.log("Webhook verify OK.");
    }
    return res.status(200).send(challenge);
  }
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true") {
    // eslint-disable-next-line no-console
    console.warn("Webhook verify FAILED.", { mode, tokenPresent: !!token });
  }
  return res.sendStatus(403);
}

async function receive(req, res) {
  const body = req.body;
  if (!body) return res.sendStatus(400);
  pushWebhookDebugEvent({
    type: "incoming",
    object: body?.object || null,
    entries: Array.isArray(body?.entry) ? body.entry.length : 0,
  });

  const debug = String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true";
  if (debug) {
    // eslint-disable-next-line no-console
    console.log("Webhook received.", {
      object: body?.object,
      entries: Array.isArray(body?.entry) ? body.entry.length : 0,
    });
  }

  const entries = Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const field = String(change?.field || "");
      const value = change?.value;

      // 1) Phone number quality updates (tier upgrades/downgrades etc.) come without metadata.phone_number_id
      if (field === "phone_number_quality_update") {
        const wabaId = entry?.id ? String(entry.id) : "";
        if (!wabaId) continue;
        const tenant = await findTenantByWabaId(wabaId);
        if (!tenant) {
          if (debug) {
            // eslint-disable-next-line no-console
            console.warn("Webhook quality_update: tenant not found for wabaId.", wabaId);
          }
          continue;
        }
        if (!tenant) continue;

        const currentLimit = value?.current_limit ? String(value.current_limit) : "";
        const ts = entry?.time ? asDateFromSeconds(entry.time) : new Date();
        if (currentLimit) {
          await WhatsAppCredentials.updateOne(
            { workspaceId: tenant.workspaceId },
            { $set: { messagingLimitTierCached: currentLimit, lastLimitsUpdateAt: ts } }
          );
        }

        continue;
      }

      // 2) Message + status webhooks (canonical) - route by phone number id
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn("Webhook change missing metadata.phone_number_id.", { field });
        }
        continue;
      }

      const tenant = await findTenantByPhoneNumberId(phoneNumberId);
      if (!tenant) {
        if (debug) {
          // eslint-disable-next-line no-console
          console.warn("Webhook: tenant not found for phone_number_id.", phoneNumberId);
        }
        continue;
      }
      const workspaceId = tenant.workspaceId;

      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      if (statuses.length) {
        pushWebhookDebugEvent({
          type: "statuses",
          field,
          phoneNumberId: String(phoneNumberId),
          statuses: statuses.map((s) => ({
            id: s?.id || null,
            status: s?.status || null,
            recipient_id: s?.recipient_id || null,
            timestamp: s?.timestamp || null,
          })),
        });
      }
      if (debug && statuses.length) {
        // eslint-disable-next-line no-console
        console.log("Webhook statuses:", statuses.map((s) => ({ id: s?.id, status: s?.status })));
      }
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
              "statusTimestamps.acceptedAt": new Date(),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }

      const messages = Array.isArray(value?.messages) ? value.messages : [];
      if (messages.length) {
        pushWebhookDebugEvent({
          type: "messages",
          field,
          phoneNumberId: String(phoneNumberId),
          messages: messages.map((m) => ({
            id: m?.id || null,
            from: m?.from || null,
            type: m?.type || null,
            timestamp: m?.timestamp || null,
          })),
        });
      }
      if (debug && messages.length) {
        // eslint-disable-next-line no-console
        console.log("Webhook inbound messages:", messages.map((m) => ({ id: m?.id, from: m?.from, type: m?.type })));
      }
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

async function listWebhookDebugEvents(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");

  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), WEBHOOK_DEBUG_LIMIT);
  return res.json({
    success: true,
    count: Math.min(limit, webhookDebugEvents.length),
    events: webhookDebugEvents.slice(0, limit),
  });
}

module.exports = { verify, receive, listWebhookDebugEvents };
