const mongoose = require("mongoose");
const { Message } = require("../models/Message");
const { HttpError } = require("../utils/httpError");

function escapeRegex(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseSort(value) {
  const v = String(value || "desc").toLowerCase();
  return v === "asc" ? 1 : -1;
}

function parseObjectId(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (!mongoose.Types.ObjectId.isValid(v)) return null;
  return new mongoose.Types.ObjectId(v);
}

async function listApiMessages(req, res) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const skip = (page - 1) * limit;

  const sortDir = parseSort(req.query.sort);
  const onlyApiCampaigns = String(req.query.onlyApiCampaigns || "true").toLowerCase() !== "false";

  const match = {
    workspaceId: new mongoose.Types.ObjectId(String(req.workspace.id)),
    direction: "outbound",
  };

  const status = String(req.query.status || "").trim();
  if (status && status !== "all") {
    match.status = status;
  }

  const templateId = parseObjectId(req.query.templateId);
  if (templateId) match.templateId = templateId;

  const campaignId = parseObjectId(req.query.campaignId);
  if (campaignId) match.campaignId = campaignId;

  const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : null;
  const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : null;
  if (dateFrom && !Number.isNaN(dateFrom.getTime())) {
    match.createdAt = { ...(match.createdAt || {}), $gte: dateFrom };
  }
  if (dateTo && !Number.isNaN(dateTo.getTime())) {
    match.createdAt = { ...(match.createdAt || {}), $lte: dateTo };
  }

  const search = String(req.query.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    match.$or = [{ phone: rx }, { whatsappMessageId: rx }, { status: rx }, { text: rx }];
  }

  const basePipeline = [
    { $match: match },
    {
      $lookup: {
        from: "templates",
        let: { templateId: "$templateId", workspaceId: "$workspaceId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$templateId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1, category: 1, status: 1 } },
        ],
        as: "template",
      },
    },
    { $unwind: { path: "$template", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "campaigns",
        let: { campaignId: "$campaignId", workspaceId: "$workspaceId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$campaignId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1, type: 1, status: 1 } },
        ],
        as: "campaign",
      },
    },
    { $unwind: { path: "$campaign", preserveNullAndEmptyArrays: true } },
    ...(onlyApiCampaigns ? [{ $match: { "campaign.type": "api" } }] : []),
  ];

  const [items, countRows] = await Promise.all([
    Message.aggregate([
      ...basePipeline,
      { $sort: { createdAt: sortDir, _id: sortDir } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          createdAt: 1,
          phone: 1,
          status: 1,
          whatsappMessageId: 1,
          campaignId: 1,
          templateId: 1,
          campaignName: "$campaign.name",
          campaignType: "$campaign.type",
          templateName: "$template.name",
          templateCategory: "$template.category",
          error: 1,
          text: 1,
        },
      },
    ]),
    Message.aggregate([...basePipeline, { $count: "total" }]),
  ]);

  const total = Number(countRows?.[0]?.total || 0);

  res.json({
    success: true,
    page,
    limit,
    total,
    items,
  });
}

async function getApiMessageDetail(req, res) {
  const id = parseObjectId(req.params.id);
  if (!id) throw new HttpError(400, "Invalid id");

  const workspaceId = new mongoose.Types.ObjectId(String(req.workspace.id));

  const rows = await Message.aggregate([
    { $match: { _id: id, workspaceId } },
    {
      $lookup: {
        from: "templates",
        let: { templateId: "$templateId", workspaceId: "$workspaceId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$templateId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1, category: 1, status: 1, components: 1 } },
        ],
        as: "template",
      },
    },
    { $unwind: { path: "$template", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "campaigns",
        let: { campaignId: "$campaignId", workspaceId: "$workspaceId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$campaignId"] },
                  { $eq: ["$workspaceId", "$$workspaceId"] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1, type: 1, status: 1, totals: 1, scheduledAt: 1, createdAt: 1 } },
        ],
        as: "campaign",
      },
    },
    { $unwind: { path: "$campaign", preserveNullAndEmptyArrays: true } },
  ]);

  const item = rows?.[0] || null;
  if (!item) throw new HttpError(404, "Message not found");

  res.json({ success: true, item });
}

module.exports = { listApiMessages, getApiMessageDetail };

