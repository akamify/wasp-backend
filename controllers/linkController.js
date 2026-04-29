const { trackingBaseUrl } = require("../config/env");
const { ClickLog } = require("../models/ClickLog");
const { createTrackingCode, verifyAndDecodeTrackingCode } = require("../utils/tracking");
const { HttpError } = require("../utils/httpError");

function assertHttpUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function createLink(req, res) {
  const url = assertHttpUrl(req.body.url);
  if (!url) throw new HttpError(400, "Invalid url (must be http/https)");

  const payload = {
    workspaceId: req.workspace.id,
    templateId: req.body.templateId,
    messageId: req.body.messageId,
    url,
    iat: Date.now(),
  };

  const code = createTrackingCode(payload);
  res.json({ success: true, trackedUrl: `${trackingBaseUrl}/t/${code}` });
}

async function redirect(req, res) {
  const { code } = req.params;
  const verified = verifyAndDecodeTrackingCode(code);
  if (!verified.ok) throw new HttpError(400, verified.error);

  const payload = verified.payload || {};
  const url = assertHttpUrl(payload.url);
  if (!url) throw new HttpError(400, "Invalid redirect url");

  const workspaceId = payload.workspaceId || payload.userId;

  await ClickLog.create({
    workspaceId,
    templateId: payload.templateId,
    messageId: payload.messageId,
    url,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.redirect(302, url);
}

module.exports = { createLink, redirect };

