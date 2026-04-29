const { Message } = require("../models/Message");
const { ClickLog } = require("../models/ClickLog");
const { Template } = require("../models/Template");
const { HttpError } = require("../utils/httpError");

async function overview(req, res) {
  const workspaceId = req.workspace.id;

  const [sent, delivered, read, failed, clicks] = await Promise.all([
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      "statusTimestamps.sentAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      "statusTimestamps.deliveredAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      "statusTimestamps.readAt": { $exists: true },
    }),
    Message.countDocuments({ workspaceId, direction: "outbound", status: "failed" }),
    ClickLog.countDocuments({ workspaceId }),
  ]);

  res.json({
    success: true,
    overview: { sent, delivered, read, failed, clicks },
  });
}

async function templatePerformance(req, res) {
  const workspaceId = req.workspace.id;
  const templateId = req.params.id;

  const template = await Template.findOne({ _id: templateId, workspaceId }).select(
    "_id name status"
  );
  if (!template) throw new HttpError(404, "Template not found");

  const [sent, delivered, read, failed, clicks] = await Promise.all([
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      templateId,
      "statusTimestamps.sentAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      templateId,
      "statusTimestamps.deliveredAt": { $exists: true },
    }),
    Message.countDocuments({
      workspaceId,
      direction: "outbound",
      templateId,
      "statusTimestamps.readAt": { $exists: true },
    }),
    Message.countDocuments({ workspaceId, direction: "outbound", templateId, status: "failed" }),
    ClickLog.countDocuments({ workspaceId, templateId }),
  ]);

  res.json({
    success: true,
    template: { id: template._id, name: template.name, status: template.status },
    metrics: { sent, delivered, read, failed, clicks },
  });
}

module.exports = { overview, templatePerformance };

