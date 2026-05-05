const { Campaign } = require("../models/Campaign");
const { Template } = require("../models/Template");
const { Message } = require("../models/Message");
const { Contact } = require("../models/Contact");
const { Transaction } = require("../models/Transaction");
const { HttpError } = require("../utils/httpError");
const { assertNormalizedPhone } = require("../services/contactService");
const { getCampaignQueue } = require("../services/campaignQueue");
const mongoose = require("mongoose");

async function listCampaigns(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const items = await Campaign.find({ workspaceId: req.workspace.id })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ success: true, campaigns: items });
}

async function getCampaign(req, res) {
  const item = await Campaign.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!item) throw new HttpError(404, "Campaign not found");
  res.json({ success: true, campaign: item });
}

async function getCampaignMetrics(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const match = {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
  };

  const countsAgg = await Message.aggregate([
    { $match: match },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(countsAgg.map((row) => [String(row._id), Number(row.count || 0)]));

  // Best-effort replied detection:
  // Any inbound message from the same phone after campaign createdAt counts as a reply.
  const phones = await Message.distinct("phone", match);
  const repliesCount = phones.length
    ? await Message.countDocuments({
        workspaceId: campaign.workspaceId,
        direction: "inbound",
        phone: { $in: phones },
        createdAt: { $gte: campaign.createdAt },
      })
    : 0;

  res.json({
    success: true,
    campaignId: String(campaign._id),
    audienceTotal: campaign.totals?.total || phones.length || 0,
    counts: {
      queued: counts.queued || 0,
      accepted: counts.accepted || 0,
      sent: counts.sent || 0,
      delivered: counts.delivered || 0,
      read: counts.read || 0,
      failed: (counts.failed || 0) + (counts.timeout_unknown || 0),
      replied: repliesCount || 0,
    },
    updatedAt: new Date().toISOString(),
  });
}

function statusFilterForTab(tab) {
  const t = String(tab || "").toLowerCase();
  if (t === "sent") return { status: { $in: ["sent"] } };
  if (t === "delivered") return { status: { $in: ["delivered"] } };
  if (t === "read") return { status: { $in: ["read"] } };
  if (t === "failed") return { status: { $in: ["failed", "timeout_unknown"] } };
  if (t === "accepted") return { status: { $in: ["accepted"] } };
  if (t === "queued") return { status: { $in: ["queued"] } };
  return {};
}

async function listCampaignMessages(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const tab = String(req.query.tab || "overview");
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
  const skip = (page - 1) * limit;

  const filter = {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
    ...statusFilterForTab(tab),
  };

  const [total, items] = await Promise.all([
    Message.countDocuments(filter),
    Message.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("phone status createdAt whatsappMessageId error statusTimestamps"),
  ]);

  const phones = items.map((m) => m.phone).filter(Boolean);
  const contacts = phones.length
    ? await Contact.find({ workspaceId: campaign.workspaceId, phone: { $in: phones } }).select("phone name")
    : [];
  const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));

  res.json({
    success: true,
    tab,
    page,
    limit,
    total,
    items: items.map((m) => ({
      id: String(m._id),
      phone: m.phone,
      name: contactMap.get(String(m.phone)) || "",
      status: m.status,
      createdAt: m.createdAt,
      whatsappMessageId: m.whatsappMessageId || null,
      error: m.error || null,
      statusTimestamps: m.statusTimestamps || null,
    })),
  });
}

async function listCampaignReplies(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const page = Math.min(Math.max(Number(req.query.page || 1), 1), 50000);
  const skip = (page - 1) * limit;

  const phones = await Message.distinct("phone", {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    direction: "outbound",
  });
  if (!phones.length) {
    return res.json({ success: true, page, limit, total: 0, items: [] });
  }

  const pipeline = [
    {
      $match: {
        workspaceId: campaign.workspaceId,
        direction: "inbound",
        phone: { $in: phones },
        createdAt: { $gte: campaign.createdAt },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$phone",
        phone: { $first: "$phone" },
        text: { $first: "$text" },
        createdAt: { $first: "$createdAt" },
      },
    },
  ];

  const [grouped, totalAgg] = await Promise.all([
    Message.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]),
    Message.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = Number(totalAgg?.[0]?.total || 0);
  const replyPhones = grouped.map((r) => String(r.phone || "")).filter(Boolean);
  const contacts = replyPhones.length
    ? await Contact.find({ workspaceId: campaign.workspaceId, phone: { $in: replyPhones } }).select("phone name")
    : [];
  const contactMap = new Map(contacts.map((c) => [String(c.phone), String(c.name || "")]));

  return res.json({
    success: true,
    page,
    limit,
    total,
    items: grouped.map((r) => ({
      phone: String(r.phone || ""),
      name: contactMap.get(String(r.phone)) || "",
      text: String(r.text || ""),
      createdAt: r.createdAt,
    })),
  });
}

async function getCampaignCreditUsage(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id }).select("_id workspaceId");
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const rows = await Transaction.aggregate([
    {
      $match: {
        workspaceId: campaign.workspaceId,
        "meta.campaignId": String(campaign._id),
      },
    },
    { $group: { _id: "$type", amount: { $sum: "$amount" } } },
  ]);

  const debits = Number(rows.find((r) => r._id === "debit")?.amount || 0);
  const credits = Number(rows.find((r) => r._id === "credit")?.amount || 0);

  res.json({
    success: true,
    campaignId: String(campaign._id),
    currency: "INR",
    debits,
    credits,
    net: Math.max(debits - credits, 0),
  });
}

async function updateCampaignStatus(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
  const action = String(req.body?.action || "").toLowerCase();

  const campaign = await Campaign.findOne({ _id: id, workspaceId: req.workspace.id });
  if (!campaign) throw new HttpError(404, "Campaign not found");

  const nextStatus =
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "running"
        : action === "stop"
          ? "cancelled"
          : null;
  if (!nextStatus) throw new HttpError(400, "Invalid action");

  campaign.status = nextStatus;
  await campaign.save();
  res.json({ success: true, campaign });
}

async function createCampaign(req, res) {
  const { name, templateId, recipients, scheduledAt, type } = req.body;

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

  const normalizedRecipients = [];
  const seen = new Set();

  for (const r of recipients || []) {
    const raw = typeof r === "string" ? { to: r } : (r || {});
    const to = assertNormalizedPhone(raw.to);
    if (!to) continue;
    if (seen.has(to)) continue;
    seen.add(to);
    normalizedRecipients.push({
      to,
      variables: Array.isArray(raw.variables) ? raw.variables : undefined,
      headerVariables: Array.isArray(raw.headerVariables) ? raw.headerVariables : undefined,
      otpCode: raw.otpCode ? String(raw.otpCode) : undefined,
      buttonValues: Array.isArray(raw.buttonValues) ? raw.buttonValues : undefined,
      buttonTtlMinutes: Array.isArray(raw.buttonTtlMinutes) ? raw.buttonTtlMinutes : undefined,
      flowTokens: Array.isArray(raw.flowTokens) ? raw.flowTokens : undefined,
      flowActionData: Array.isArray(raw.flowActionData) ? raw.flowActionData : undefined,
    });
  }

  if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");

  const campaign = await Campaign.create({
    workspaceId: req.workspace.id,
    name,
    templateId: template._id,
    status: "queued",
    type: type || "broadcast",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
    totals: {
      total: normalizedRecipients.length,
      queued: normalizedRecipients.length,
      sent: 0,
      failed: 0,
    },
  });

  const delayMs = campaign.scheduledAt ? Math.max(campaign.scheduledAt.getTime() - Date.now(), 0) : 0;

  const campaignQueue = getCampaignQueue();
  await Promise.all(
    normalizedRecipients.map((recipient) =>
      campaignQueue.add(
        "send-message",
        {
          workspaceId: req.workspace.id,
          campaignId: String(campaign._id),
          templateId: String(template._id),
          to: recipient.to,
          variables: recipient.variables,
          headerVariables: recipient.headerVariables,
          otpCode: recipient.otpCode,
          buttonValues: recipient.buttonValues,
          buttonTtlMinutes: recipient.buttonTtlMinutes,
          flowTokens: recipient.flowTokens,
          flowActionData: recipient.flowActionData,
        },
        {
          delay: delayMs,
          removeOnComplete: 5000,
          removeOnFail: 5000,
        }
      )
    )
  );

  res.status(201).json({ success: true, campaign });
}

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaign,
  getCampaignMetrics,
  listCampaignMessages,
  listCampaignReplies,
  getCampaignCreditUsage,
  updateCampaignStatus,
};
