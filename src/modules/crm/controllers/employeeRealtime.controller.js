const { subscribeWorkspaceEvents } = require("@shared/services/realtimeService");
const { createRedisConnection } = require("@infra/redis/redisClient");

async function streamEmployeeRealtime(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const writeEvent = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeEvent("ready", { workspaceId: req.workspace.id, employeeId: req.employee.id });

  const redis = createRedisConnection();
  const allowKey = `crm:employee:${String(req.employee.id)}:assignedPhones`;
  let allowedPhones = new Set();

  async function refreshAllowlist() {
    try {
      const phones = await redis.smembers(allowKey);
      allowedPhones = new Set((phones || []).map((p) => String(p)));
    } catch {
      // ignore
    }
  }

  await refreshAllowlist();
  const refreshTimer = setInterval(refreshAllowlist, 15000);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  const unsubscribe = subscribeWorkspaceEvents(req.workspace.id, (event) => {
    // If event has a phone, only allow when employee is assignee.
    const eventPhone = event?.phone ? String(event.phone) : "";
    if (!eventPhone) return writeEvent("message", event);
    if (allowedPhones.has(eventPhone)) return writeEvent("message", event);
  });

  req.on("close", () => {
    clearInterval(refreshTimer);
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
}

module.exports = { streamEmployeeRealtime };
