const mongoose = require("mongoose");
const { ConversionEvent } = require("@infra/database/ConversionEvent");
const { Contact } = require("@infra/database/Contact");
const { Message } = require("@infra/database/Message");
const { HttpError } = require("@shared/utils/httpError");
const { normalizePhone } = require("@shared/services/contactService");
const {
  resolveMessageAttribution,
  syncContactEngagement,
} = require("@modules/analytics/services/customerEngagement.service");

function setPublicCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeEventName(value) {
  const eventName = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "page_view",
    "signup",
    "lead_submit",
    "add_to_cart",
    "checkout_started",
    "purchase",
  ]);
  if (!allowed.has(eventName)) throw new HttpError(400, "Invalid conversion event");
  return eventName;
}

function normalizeCurrency(value) {
  return String(value || "INR").trim().toUpperCase().slice(0, 8) || "INR";
}

function normalizeMetadata(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function inferDedupeKey({ source, eventName, trackingToken, messageId, phone, metadata }) {
  const orderId = String(metadata?.orderId || metadata?.order_id || "").trim();
  if (orderId) return `${source}:${eventName}:order:${orderId}`;
  if (trackingToken) return `${source}:${eventName}:token:${trackingToken}`;
  if (messageId) return `${source}:${eventName}:message:${messageId}`;
  if (phone) return `${source}:${eventName}:phone:${phone}`;
  return null;
}

async function findContactByPhone({ workspaceId, phone }) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return Contact.findOne({ workspaceId, phone: normalized }).lean();
}

async function hydrateAttribution({ workspaceId, trackingToken, messageId, phone }) {
  const message = await resolveMessageAttribution({ workspaceId, trackingToken, messageId, phone });
  const contact =
    message?.contactId
      ? await Contact.findOne({ _id: message.contactId, workspaceId }).lean()
      : await findContactByPhone({ workspaceId, phone: phone || message?.phone });

  return {
    message,
    contact,
    trackingToken: trackingToken || message?.tracking?.trackingToken || null,
    phone: normalizePhone(phone || contact?.phone || message?.phone || ""),
  };
}

async function writeConversionEvent({
  workspaceId,
  source,
  trackingToken,
  messageId,
  phone,
  eventName,
  value,
  currency,
  metadata,
}) {
  if (!workspaceId) throw new HttpError(400, "workspaceId is required");
  const attribution = await hydrateAttribution({ workspaceId, trackingToken, messageId, phone });
  if (!attribution.message && !attribution.contact) {
    throw new HttpError(404, "No attributable customer or message found for conversion event");
  }

  const eventPayload = {
    workspaceId,
    contactId: attribution.contact?._id || attribution.message?.contactId || null,
    messageId: attribution.message?._id || null,
    campaignId: attribution.message?.campaignId || null,
    templateId: attribution.message?.templateId || null,
    assignedEmployeeId: attribution.message?.lastAssignedEmployeeId || null,
    phone: attribution.phone || null,
    trackingToken: attribution.trackingToken || null,
    eventName,
    value,
    currency,
    metadata,
    source,
    timestamp: metadata?.timestamp ? new Date(metadata.timestamp) : new Date(),
  };
  const dedupeKey = inferDedupeKey({
    source,
    eventName,
    trackingToken: eventPayload.trackingToken,
    messageId: eventPayload.messageId ? String(eventPayload.messageId) : "",
    phone: eventPayload.phone,
    metadata,
  });
  if (dedupeKey) eventPayload.dedupeKey = dedupeKey;

  let event;
  try {
    event = await ConversionEvent.create(eventPayload);
  } catch (error) {
    if (Number(error?.code) === 11000 && dedupeKey) {
      event = await ConversionEvent.findOne({ workspaceId, dedupeKey });
      if (!event) throw error;
    } else {
      throw error;
    }
  }

  if (eventPayload.messageId) {
    const incrementRevenue = eventName === "purchase" ? Math.max(0, value) : 0;
    await Message.updateOne(
      { _id: eventPayload.messageId, workspaceId },
      {
        $set: {
          "conversion.converted": true,
          "conversion.lastConversionAt": event.timestamp,
        },
        $inc: {
          "conversion.totalRevenue": incrementRevenue,
        },
        $push: {
          "conversion.events": {
            eventId: event._id,
            eventName,
            value,
            currency,
            source,
            timestamp: event.timestamp,
          },
        },
      }
    );
  }

  if (eventPayload.contactId) {
    await syncContactEngagement(eventPayload.contactId);
  }

  return {
    event,
    attribution: {
      contactId: eventPayload.contactId ? String(eventPayload.contactId) : null,
      messageId: eventPayload.messageId ? String(eventPayload.messageId) : null,
      campaignId: eventPayload.campaignId ? String(eventPayload.campaignId) : null,
      templateId: eventPayload.templateId ? String(eventPayload.templateId) : null,
    },
  };
}

async function publicCollect(req, res) {
  setPublicCors(res);
  const eventName = normalizeEventName(req.body?.event || req.body?.eventName);
  const value = parseNumber(req.body?.value ?? req.body?.amount, 0);
  const currency = normalizeCurrency(req.body?.currency);
  const metadata = normalizeMetadata(req.body?.metadata);
  const trackingToken = String(req.body?.trackingToken || req.body?.token || "").trim();
  if (!trackingToken) throw new HttpError(400, "trackingToken is required");
  const message = await Message.findOne({ "tracking.trackingToken": trackingToken }).select("workspaceId").lean();
  if (!message?.workspaceId) throw new HttpError(404, "Tracked message not found");
  const result = await writeConversionEvent({
    workspaceId: message.workspaceId,
    source: "pixel",
    trackingToken,
    messageId: null,
    phone: req.body?.phone || null,
    eventName,
    value,
    currency,
    metadata,
  });

  res.json({ success: true, eventId: String(result.event._id), attribution: result.attribution });
}

async function serverCollect(req, res) {
  const eventName = normalizeEventName(req.body?.event || req.body?.eventName);
  const value = parseNumber(req.body?.value ?? req.body?.amount, 0);
  const currency = normalizeCurrency(req.body?.currency);
  const metadata = normalizeMetadata({
    ...normalizeMetadata(req.body?.metadata),
    orderId: req.body?.orderId || req.body?.metadata?.orderId || null,
  });

  const workspaceId = req.workspace.id;
  const result = await writeConversionEvent({
    workspaceId,
    source: "server",
    trackingToken: String(req.body?.trackingToken || "").trim() || null,
    messageId: req.body?.messageId || null,
    phone: req.body?.phone || null,
    eventName,
    value,
    currency,
    metadata,
  });

  res.status(201).json({ success: true, eventId: String(result.event._id), attribution: result.attribution });
}

async function pixelScript(req, res) {
  setPublicCors(res);
  res.type("application/javascript");
  return res.send(`
(function () {
  var CURRENT_SCRIPT = document.currentScript;
  var SCRIPT_ORIGIN = CURRENT_SCRIPT ? new URL(CURRENT_SCRIPT.src).origin : "";
  var STORAGE_KEY = "aiwiz_tid";

  function readToken() {
    try {
      var params = new URLSearchParams(window.location.search || "");
      var fromQuery = params.get("aiwiz_tid");
      if (fromQuery) {
        localStorage.setItem(STORAGE_KEY, fromQuery);
        return fromQuery;
      }
      var saved = localStorage.getItem(STORAGE_KEY);
      return saved || "";
    } catch (err) {
      return "";
    }
  }

  function post(payload) {
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      var blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(SCRIPT_ORIGIN + "/public/conversions/collect", blob);
      return Promise.resolve();
    }
    return fetch(SCRIPT_ORIGIN + "/public/conversions/collect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true
    });
  }

  window.aiwiz = window.aiwiz || {};
  window.aiwiz.track = function (eventName, data) {
    var payload = Object.assign({}, data || {});
    payload.event = eventName;
    payload.trackingToken = payload.trackingToken || readToken();
    if (!payload.trackingToken) return Promise.resolve({ skipped: true, reason: "tracking_token_missing" });
    return post(payload);
  };
})();
  `);
}

function publicOptions(req, res) {
  setPublicCors(res);
  return res.sendStatus(204);
}

module.exports = {
  pixelScript,
  publicCollect,
  publicOptions,
  serverCollect,
};
