const { Campaign } = require("../models/Campaign");
const { Template } = require("../models/Template");
const { HttpError } = require("../utils/httpError");
const { assertNormalizedPhone } = require("../services/contactService");
const { getCampaignQueue } = require("../services/campaignQueue");

async function listCampaigns(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
  const items = await Campaign.find({ workspaceId: req.workspace.id })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ success: true, campaigns: items });
}

async function createCampaign(req, res) {
  const { name, templateId, recipients, scheduledAt } = req.body;

  const template = await Template.findOne({ _id: templateId, workspaceId: req.workspace.id });
  if (!template) throw new HttpError(404, "Template not found");
  if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

  const normalizedRecipients = Array.from(
    new Set((recipients || []).map((r) => assertNormalizedPhone(r)))
  );
  if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");

  const campaign = await Campaign.create({
    workspaceId: req.workspace.id,
    name,
    templateId: template._id,
    status: "queued",
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
    normalizedRecipients.map((to) =>
      campaignQueue.add(
        "send-message",
        {
          workspaceId: req.workspace.id,
          campaignId: String(campaign._id),
          templateId: String(template._id),
          to,
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

module.exports = { listCampaigns, createCampaign };

