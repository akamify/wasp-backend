const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(1000);

function workspaceChannel(workspaceId) {
  return `workspace:${String(workspaceId || "").trim()}`;
}

function publishWorkspaceEvent(workspaceId, event) {
  const channel = workspaceChannel(workspaceId);
  if (!channel) return;
  bus.emit(channel, {
    at: new Date().toISOString(),
    ...event,
  });
}

function subscribeWorkspaceEvents(workspaceId, handler) {
  const channel = workspaceChannel(workspaceId);
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}

module.exports = {
  publishWorkspaceEvent,
  subscribeWorkspaceEvents,
};

