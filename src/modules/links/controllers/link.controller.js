const { trackingBaseUrl } = require("@core/config/env");
const { ClickLog } = require("@infra/database/ClickLog");
const { TrackedLink } = require("@infra/database/TrackedLink");
const { createTrackingCode, verifyAndDecodeTrackingCode } = require("@shared/utils/tracking");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const axios = require("axios");
const QRCode = require("qrcode");
const crypto = require("crypto");

function randomSlug(len = 14) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

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

function normalizeDigitsOnlyPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits;
}

function buildWaMeUrl(phoneDigits, message) {
  const encoded = encodeURIComponent(String(message || ""));
  return `https://wa.me/${phoneDigits}?text=${encoded}`;
}

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

async function getWorkspaceDisplayPhone({ workspaceId }) {
  const creds = await getCredentialsForUser(workspaceId);
  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 15000 });
  const headers = { Authorization: `Bearer ${creds.accessToken}` };
  const res = await client.get(`/${creds.phoneNumberId}`, {
    params: { fields: "id,display_phone_number" },
    headers,
  });
  const display = res.data?.display_phone_number || "";
  const digits = normalizeDigitsOnlyPhone(display);
  if (!digits) throw new HttpError(400, "Unable to resolve WhatsApp display phone number from Meta");
  return digits;
}

async function createWhatsAppTrackedLink(req, res) {
  const message = String(req.body.message || "").trim();
  if (!message) throw new HttpError(400, "Message is required");

  const waPhone = await getWorkspaceDisplayPhone({ workspaceId: req.workspace.id });
  const redirectUrl = buildWaMeUrl(waPhone, message);

  const slug = randomSlug();
  const link = await TrackedLink.create({
    workspaceId: req.workspace.id,
    title: String(req.body.title || "").trim(),
    message,
    waPhone,
    redirectUrl,
    slug,
  });

  res.status(201).json({
    success: true,
    link,
    trackedUrl: `${trackingBaseUrl}/t/${slug}`,
  });
}

async function listTrackedLinks(req, res) {
  const links = await TrackedLink.find({ workspaceId: req.workspace.id, isDeleted: false })
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    success: true,
    links: (links || []).map((l) => ({ ...l, trackedUrl: `${trackingBaseUrl}/t/${l.slug}` })),
  });
}

async function updateTrackedLink(req, res) {
  const link = await TrackedLink.findOne({ _id: req.params.id, workspaceId: req.workspace.id, isDeleted: false });
  if (!link) throw new HttpError(404, "Link not found");

  const nextMessage = req.body.message !== undefined ? String(req.body.message || "").trim() : link.message;
  if (!nextMessage) throw new HttpError(400, "Message is required");

  const nextTitle = req.body.title !== undefined ? String(req.body.title || "").trim() : link.title;

  // Keep waPhone stable; if missing (older rows), resolve from Meta.
  const waPhone = link.waPhone ? String(link.waPhone) : await getWorkspaceDisplayPhone({ workspaceId: req.workspace.id });
  const redirectUrl = buildWaMeUrl(waPhone, nextMessage);

  link.title = nextTitle;
  link.message = nextMessage;
  link.waPhone = waPhone;
  link.redirectUrl = redirectUrl;
  await link.save();

  res.json({ success: true, link, trackedUrl: `${trackingBaseUrl}/t/${link.slug}` });
}

async function deleteTrackedLink(req, res) {
  const link = await TrackedLink.findOne({ _id: req.params.id, workspaceId: req.workspace.id, isDeleted: false });
  if (!link) throw new HttpError(404, "Link not found");
  link.isDeleted = true;
  await link.save();
  res.json({ success: true });
}

async function getTrackedLinkAnalytics(req, res) {
  const link = await TrackedLink.findOne({ _id: req.params.id, workspaceId: req.workspace.id, isDeleted: false }).lean();
  if (!link) throw new HttpError(404, "Link not found");

  const days = Math.max(1, Math.min(Number(req.query.days || 14), 90));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await ClickLog.aggregate([
    { $match: { workspaceId: link.workspaceId, linkId: link._id, clickedAt: { $gte: since } } },
    {
      $group: {
        _id: {
          y: { $year: "$clickedAt" },
          m: { $month: "$clickedAt" },
          d: { $dayOfMonth: "$clickedAt" },
          source: "$source",
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
  ]);

  const byDay = {};
  for (const r of rows) {
    const key = `${r._id.y}-${String(r._id.m).padStart(2, "0")}-${String(r._id.d).padStart(2, "0")}`;
    if (!byDay[key]) byDay[key] = { date: key, clicks: 0, scans: 0 };
    if (r._id.source === "qr") byDay[key].scans += r.count;
    else byDay[key].clicks += r.count;
  }

  const series = Object.values(byDay);
  const totals = series.reduce(
    (acc, v) => ({ clicks: acc.clicks + v.clicks, scans: acc.scans + v.scans }),
    { clicks: 0, scans: 0 }
  );

  res.json({ success: true, link: { ...link, trackedUrl: `${trackingBaseUrl}/t/${link.slug}` }, totals, series });
}

async function qrSvg(req, res) {
  const link = await TrackedLink.findOne({ _id: req.params.id, workspaceId: req.workspace.id, isDeleted: false }).lean();
  if (!link) throw new HttpError(404, "Link not found");
  const trackedUrl = `${trackingBaseUrl}/t/${link.slug}?source=qr`;
  const svg = await QRCode.toString(trackedUrl, { type: "svg", margin: 1, width: 512 });
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Content-Disposition", `attachment; filename=\"${link.slug}.svg\"`);
  res.send(svg);
}

async function qrPng(req, res) {
  const link = await TrackedLink.findOne({ _id: req.params.id, workspaceId: req.workspace.id, isDeleted: false }).lean();
  if (!link) throw new HttpError(404, "Link not found");
  const trackedUrl = `${trackingBaseUrl}/t/${link.slug}?source=qr`;
  const buf = await QRCode.toBuffer(trackedUrl, { type: "png", margin: 1, width: 512 });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename=\"${link.slug}.png\"`);
  res.send(buf);
}

async function redirect(req, res) {
  const { code } = req.params;

  // New mode: `/t/:slug` (no dot) for persisted tracked WhatsApp links.
  if (!String(code || "").includes(".")) {
    const slug = String(code || "").trim();
    const link = await TrackedLink.findOne({ slug, isDeleted: false });
    if (!link) throw new HttpError(404, "Invalid link");

    const source = String(req.query.source || "").toLowerCase() === "qr" ? "qr" : "link";
    await ClickLog.create({
      workspaceId: link.workspaceId,
      linkId: link._id,
      url: link.redirectUrl,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      referer: req.headers.referer || null,
      source,
    });

    if (source === "qr") {
      await TrackedLink.updateOne({ _id: link._id }, { $inc: { scans: 1 } });
    } else {
      await TrackedLink.updateOne({ _id: link._id }, { $inc: { clicks: 1 } });
    }

    return res.redirect(302, link.redirectUrl);
  }

  // Legacy mode: signed codes for arbitrary URLs.
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
    referer: req.headers.referer || null,
    source: "unknown",
  });

  return res.redirect(302, url);
}

module.exports = {
  createLink,
  redirect,
  createWhatsAppTrackedLink,
  listTrackedLinks,
  updateTrackedLink,
  deleteTrackedLink,
  getTrackedLinkAnalytics,
  qrSvg,
  qrPng,
};


