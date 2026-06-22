const axios = require("axios");
const crypto = require("crypto");
const { ExternalChatWebhook } = require("@infra/database/ExternalChatWebhook");
const { Contact } = require("@infra/database/Contact");
const { webhookQueue } = require("@infra/queues/index");
const { HttpError } = require("@shared/utils/httpError");
const { toExternalContactDto } = require("@modules/external-chat/dto/externalContact.dto");
const { mapExternalRealtimeEvent } = require("@modules/external-chat/services/externalRealtimeMap.service");

const EXTERNAL_CHAT_WEBHOOK_EVENTS = [
  "message.created",
  "message.status_updated",
  "conversation.updated",
  "contact.updated",
];

function normalizeEvents(events) {
  const input = Array.isArray(events) && events.length ? events : EXTERNAL_CHAT_WEBHOOK_EVENTS;
  return Array.from(
    new Set(input.map((event) => String(event || "").trim()).filter((event) => EXTERNAL_CHAT_WEBHOOK_EVENTS.includes(event)))
  );
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function maskSecret(secret) {
  const text = String(secret || "");
  if (!text) return "";
  return `${text.slice(0, 9)}...${text.slice(-4)}`;
}

function toWebhookDto(doc, extras = {}) {
  if (!doc) return null;
  const w = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(w._id || ""),
    url: String(w.url || ""),
    events: normalizeEvents(w.events),
    enabled: Boolean(w.enabled),
    lastDelivery: w.lastDelivery || null,
    failureCount: Number(w.failureCount || 0),
    createdAt: w.createdAt || null,
    updatedAt: w.updatedAt || null,
    ...extras,
  };
}

function scopeFilter({ workspaceId, apiKeyId }) {
  return {
    workspaceId,
    ...(apiKeyId ? { apiKeyId } : {}),
  };
}

async function listWebhooks({ workspaceId, apiKeyId }) {
  const items = await ExternalChatWebhook.find(scopeFilter({ workspaceId, apiKeyId })).sort({ createdAt: -1 });
  return items.map((item) => toWebhookDto(item));
}

async function createWebhook({ workspaceId, apiKeyId, url, events }) {
  const secret = generateWebhookSecret();
  const doc = await ExternalChatWebhook.create({
    workspaceId,
    apiKeyId: apiKeyId || null,
    url,
    events: normalizeEvents(events),
    enabled: true,
    secret,
    secretHash: hashSecret(secret),
  });
  return toWebhookDto(doc, { secret, secretPreview: maskSecret(secret) });
}

async function updateWebhook({ workspaceId, apiKeyId, webhookId, patch }) {
  const $set = {};
  if (patch.url !== undefined) $set.url = patch.url;
  if (patch.enabled !== undefined) $set.enabled = Boolean(patch.enabled);
  if (patch.events !== undefined) $set.events = normalizeEvents(patch.events);
  const doc = await ExternalChatWebhook.findOneAndUpdate(
    { _id: webhookId, ...scopeFilter({ workspaceId, apiKeyId }) },
    { $set },
    { returnDocument: "after" }
  );
  if (!doc) throw new HttpError(404, "Webhook endpoint not found", { code: "WEBHOOK_NOT_FOUND" });
  return toWebhookDto(doc);
}

async function deleteWebhook({ workspaceId, apiKeyId, webhookId }) {
  const deleted = await ExternalChatWebhook.findOneAndDelete({ _id: webhookId, ...scopeFilter({ workspaceId, apiKeyId }) });
  if (!deleted) throw new HttpError(404, "Webhook endpoint not found", { code: "WEBHOOK_NOT_FOUND" });
  return { deleted: true };
}

async function rotateWebhookSecret({ workspaceId, apiKeyId, webhookId }) {
  const secret = generateWebhookSecret();
  const doc = await ExternalChatWebhook.findOneAndUpdate(
    { _id: webhookId, ...scopeFilter({ workspaceId, apiKeyId }) },
    { $set: { secret, secretHash: hashSecret(secret) } },
    { returnDocument: "after" }
  );
  if (!doc) throw new HttpError(404, "Webhook endpoint not found", { code: "WEBHOOK_NOT_FOUND" });
  return toWebhookDto(doc, { secret, secretPreview: maskSecret(secret) });
}

function mapInternalEventType(eventType) {
  const normalized = String(eventType || "").toLowerCase();
  if (["message_inbound", "message_outbound"].includes(normalized)) return "message.created";
  if (normalized === "message_status") return "message.status_updated";
  if (normalized === "conversation.updated") return "conversation.updated";
  if (normalized === "contact.updated") return "contact.updated";
  return "";
}

async function enqueueExternalWebhookEvent(workspaceId, event) {
  const eventName = mapInternalEventType(event?.type);
  if (!eventName) return;
  const queue = webhookQueue.getWebhookQueue();
  await queue.add("external-chat.deliver", {
    workspaceId: String(workspaceId),
    event,
  });
}

async function mapExternalWebhookPayload(workspaceId, event) {
  const eventName = mapInternalEventType(event?.type);
  if (!eventName) return null;

  if (eventName === "contact.updated") {
    const contact = event?.contactId
      ? await Contact.findOne({ _id: event.contactId, workspaceId })
      : await Contact.findOne({ workspaceId, phone: String(event?.phone || "") });
    if (!contact) return null;
    return {
      type: "contact.updated",
      data: { contact: toExternalContactDto(contact) },
    };
  }

  const mapped = await mapExternalRealtimeEvent(workspaceId, event);
  if (!mapped) return null;
  const data = { ...mapped.data };

  const phone = data.message?.phone || data.conversation?.phone || event?.phone || "";
  if (phone) {
    const contact = await Contact.findOne({ workspaceId, phone: String(phone) });
    if (contact) data.contact = toExternalContactDto(contact);
  }

  return {
    type: mapped.type,
    data,
  };
}

async function deliverExternalWebhookJob(job) {
  const workspaceId = String(job?.data?.workspaceId || "");
  const mapped = await mapExternalWebhookPayload(workspaceId, job?.data?.event || {});
  if (!workspaceId || !mapped) return { skipped: true };

  const subscribers = await ExternalChatWebhook.find({
    workspaceId,
    enabled: true,
    events: mapped.type,
  }).select("+secret");

  if (!subscribers.length) return { delivered: 0 };

  const payload = {
    id: crypto.randomUUID(),
    type: mapped.type,
    createdAt: new Date().toISOString(),
    workspaceId,
    data: mapped.data,
  };
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));

  let delivered = 0;
  for (const subscriber of subscribers) {
    const deliveryId = crypto.randomUUID();
    const signature = crypto
      .createHmac("sha256", String(subscriber.secret || ""))
      .update(`${timestamp}.${body}`)
      .digest("hex");

    try {
      const response = await axios.post(subscriber.url, payload, {
        timeout: Math.max(Number(process.env.EXTERNAL_CHAT_WEBHOOK_TIMEOUT_MS || 10000), 1000),
        headers: {
          "Content-Type": "application/json",
          "X-Waspakamify-Event": mapped.type,
          "X-Waspakamify-Timestamp": timestamp,
          "X-Waspakamify-Delivery-Id": deliveryId,
          "X-Waspakamify-Signature": `sha256=${signature}`,
        },
      });
      delivered += 1;
      await ExternalChatWebhook.updateOne(
        { _id: subscriber._id },
        {
          $set: {
            lastDelivery: {
              status: "success",
              statusCode: response.status,
              event: mapped.type,
              deliveryId,
              error: "",
              at: new Date(),
            },
            failureCount: 0,
          },
        }
      );
    } catch (err) {
      await ExternalChatWebhook.updateOne(
        { _id: subscriber._id },
        {
          $set: {
            lastDelivery: {
              status: "failed",
              statusCode: err?.response?.status || null,
              event: mapped.type,
              deliveryId,
              error: String(err?.message || "Webhook delivery failed").slice(0, 500),
              at: new Date(),
            },
          },
          $inc: { failureCount: 1 },
        }
      );
      throw err;
    }
  }

  return { delivered };
}

module.exports = {
  EXTERNAL_CHAT_WEBHOOK_EVENTS,
  normalizeEvents,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  enqueueExternalWebhookEvent,
  deliverExternalWebhookJob,
};
