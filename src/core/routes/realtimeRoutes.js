const express = require("express");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("@core/config/env");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { subscribeWorkspaceEvents } = require("@shared/services/realtimeService");

const router = express.Router();

function authFromQuery(req, res, next) {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(401).json({ success: false, message: "Missing token" });
  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = { id: payload.sub, role: payload.role, workspaceId: payload.workspaceId };
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

router.get("/stream", authFromQuery, requireWorkspace, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");

  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const writeEvent = (type, payload) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeEvent("ready", { workspaceId: req.workspace.id });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  const unsubscribe = subscribeWorkspaceEvents(req.workspace.id, (event) => {
    writeEvent("message", event);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

module.exports = router;


