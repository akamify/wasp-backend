const { EventEmitter } = require("events");
const { enqueueExternalWebhookEvent } = require("@modules/external-chat/services/externalWebhook.service");
const { createRealtimeRedisConnections } = require("@infra/redis/redisClient");
const crypto = require("crypto");

const bus = new EventEmitter();
bus.setMaxListeners(1000);
const instanceId = `${process.pid}:${crypto.randomUUID()}`;
let redisInitialized = false;
let redisPublisher = null;

function workspaceChannel(workspaceId) {
  const id = String(workspaceId || "").trim();
  return id ? `workspace:${id}` : "";
}

function emitLocal(workspaceId, eventName, payload, at = new Date().toISOString()) {
  const channel = workspaceChannel(workspaceId);
  if (!channel) return;
  bus.emit(channel, { at, ...payload }, eventName);
}

function ensureRedisPubSub() {
  if (redisInitialized || String(process.env.DISABLE_REDIS || "").toLowerCase() === "true") return;
  redisInitialized = true;
  try {
    const { publisher, subscriber } = createRealtimeRedisConnections();
    redisPublisher = publisher;
    subscriber.on("pmessage", (_pattern, channel, raw) => {
      try {
        const envelope = JSON.parse(raw);
        if (envelope.origin === instanceId) return;
        const workspaceId = String(channel || "").replace(/^waspakamify:realtime:/, "");
        emitLocal(workspaceId, envelope.eventName, envelope.payload, envelope.at);
      } catch (_) {
        // Ignore malformed pub/sub payloads.
      }
    });
    subscriber.psubscribe("waspakamify:realtime:*").catch(() => {});
  } catch (_) {
    redisPublisher = null;
  }
}

function publishToWorkspace(workspaceId, eventName, payload = {}) {
  const id = String(workspaceId || "").trim();
  const name = String(eventName || "").trim();
  if (!id || !name) return;
  const at = new Date().toISOString();
  emitLocal(id, name, payload, at);
  if (["message:new", "message:status", "conversation:update", "unread:update"].includes(name)) {
    console.info(`[realtime] publish ${name}`, { workspaceId: id });
  }
  ensureRedisPubSub();
  if (redisPublisher) {
    const channel = `waspakamify:realtime:${id}`;
    redisPublisher.publish(channel, JSON.stringify({ origin: instanceId, eventName: name, payload, at })).catch(() => {});
  }
}

function publishWorkspaceEvent(workspaceId, event) {
  publishToWorkspace(workspaceId, String(event?.type || "message"), event);
  enqueueExternalWebhookEvent(workspaceId, event).catch(() => {});
}

function subscribeWorkspaceEvents(workspaceId, handler) {
  const channel = workspaceChannel(workspaceId);
  if (!channel) return () => {};
  ensureRedisPubSub();
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

module.exports = {
  publishWorkspaceEvent,
  publishToWorkspace,
  subscribeWorkspaceEvents,
};

