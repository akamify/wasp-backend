const mongoose = require("mongoose");
const { Campaign } = require("../models/Campaign");
const { Message } = require("../models/Message");
const { Template } = require("../models/Template");
const { HttpError } = require("../utils/httpError");

function normalizeLimit(value, max) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return Math.min(25, max);
  return Math.min(Math.max(Math.floor(n), 1), max);
}

function safeString(value) {
  return value == null ? "" : String(value);
}

function messageErrorSummary(errorObj) {
  if (!errorObj) return "";
  if (typeof errorObj === "string") return errorObj;
  if (typeof errorObj?.message === "string") return errorObj.message;
  if (typeof errorObj?.providerError === "string") return errorObj.providerError;
  try {
    return JSON.stringify(errorObj).slice(0, 600);
  } catch {
    return "Unknown error";
  }
}

async function listApiCampaignReports(req, res) {
  const limit = normalizeLimit(req.query.limit, 200);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  const query = { workspaceId: req.workspace.id, type: "api" };
  if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
    query._id = { $lt: cursor };
  }

  const items = await Campaign.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .select("_id name templateId status totals lastError createdAt updatedAt");

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;

  const templateIds = Array.from(new Set(page.map((c) => String(c.templateId || "")).filter(Boolean)));
  const templates = templateIds.length
    ? await Template.find({ _id: { $in: templateIds }, workspaceId: req.workspace.id }).select("_id name")
    : [];
  const templateNameById = new Map(templates.map((t) => [String(t._id), t.name]));

  res.json({
    success: true,
    campaigns: page.map((c) => ({
      id: String(c._id),
      name: c.name,
      status: c.status,
      totals: c.totals || { total: 0, queued: 0, sent: 0, failed: 0 },
      template: {
        id: String(c.templateId || ""),
        name: templateNameById.get(String(c.templateId || "")) || "",
      },
      lastError: c.lastError || null,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
    nextCursor: hasMore ? String(page[page.length - 1]?._id) : null,
  });
}

async function getApiCampaignReport(req, res) {
  const id = String(req.params.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id, type: "api" }).select(
    "_id name templateId status totals lastError scheduledAt createdAt updatedAt"
  );
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const template = await Template.findOne({ _id: campaign.templateId, workspaceId: req.workspace.id }).select(
    "_id name category language status createdAt"
  );

  const grouped = await Message.aggregate([
    {
      $match: {
        workspaceId: new mongoose.Types.ObjectId(String(req.workspace.id)),
        campaignId: new mongoose.Types.ObjectId(String(campaign._id)),
        direction: "outbound",
      },
    },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(grouped.map((row) => [safeString(row._id), Number(row.count || 0)]));

  const failedMessages = await Message.find({
    workspaceId: req.workspace.id,
    campaignId: campaign._id,
    direction: "outbound",
    status: { $in: ["failed", "timeout_unknown"] },
  })
    .sort({ updatedAt: -1, createdAt: -1, _id: -1 })
    .limit(50)
    .select("_id phone status whatsappMessageId error statusTimestamps createdAt updatedAt");

  res.json({
    success: true,
    campaign: {
      id: String(campaign._id),
      name: campaign.name,
      status: campaign.status,
      totals: campaign.totals || { total: 0, queued: 0, sent: 0, failed: 0 },
      scheduledAt: campaign.scheduledAt || null,
      lastError: campaign.lastError || null,
      createdAt: campaign.createdAt,
      updatedAt: campaign.updatedAt,
    },
    template: template
      ? {
          id: String(template._id),
          name: template.name,
          category: template.category,
          language: template.language,
          status: template.status,
        }
      : null,
    stats: {
      byStatus,
    },
    failures: failedMessages.map((m) => ({
      id: String(m._id),
      phone: m.phone,
      status: m.status,
      whatsappMessageId: m.whatsappMessageId || null,
      error: messageErrorSummary(m.error),
      timestamps: m.statusTimestamps || null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
  });
}

module.exports = { listApiCampaignReports, getApiCampaignReport };

