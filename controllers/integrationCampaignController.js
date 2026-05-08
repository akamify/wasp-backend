const { Campaign } = require("../models/Campaign");
const { Workspace } = require("../models/Workspace");
const { HttpError } = require("../utils/httpError");
const { createCampaign } = require("./campaignController");

function campaignRunName(base) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${String(base || "").trim()} - ${ts}`.slice(0, 140);
}

async function resolveWorkspaceIdFromApiKeyUser(req) {
  const workspaceIdHeader = req.headers["x-workspace-id"];
  if (workspaceIdHeader) {
    return String(workspaceIdHeader);
  }

  const ws = await Workspace.findOne({ ownerId: req.user.id, isActive: true })
    .sort({ createdAt: 1 })
    .select("_id");
  if (!ws) throw new HttpError(404, "Workspace not found for API key owner");
  return String(ws._id);
}

async function sendApiCampaignByName(req, res, next) {
  try {
    const workspaceId = await resolveWorkspaceIdFromApiKeyUser(req);

    const campaignName = String(req.body?.campaignName || "").trim();
    if (!campaignName) throw new HttpError(400, "campaignName is required");

    const definition = await Campaign.findOne({
      workspaceId,
      type: "api",
      name: campaignName,
    }).select("_id name templateId type");

    if (!definition) {
      throw new HttpError(404, "API campaign not found. Create an API campaign with this name first.");
    }

    // Reuse the existing campaign creation flow (wallet checks, queuing, inline send fallback).
    req.workspace = { id: workspaceId };
    req.body = {
      name: campaignRunName(campaignName),
      type: "api",
      templateId: String(definition.templateId),
      recipients: req.body?.recipients,
      scheduledAt: req.body?.scheduledAt,
    };

    return createCampaign(req, res, next);
  } catch (err) {
    return next(err);
  }
}

module.exports = { sendApiCampaignByName };

