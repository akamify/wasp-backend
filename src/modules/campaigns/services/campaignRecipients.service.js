const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { campaignsRepository, messagesRepository, templatesRepository } = require("@modules/campaigns/repositories/index");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { ensureBalance, getOrCreateWallet, walletChargesEnabled } = require("@modules/wallet/services/wallet.core.service");
const { CAMPAIGN_STATUSES, CAMPAIGN_TYPES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { enqueueCampaignRecipients } = require("@modules/campaigns/services/campaignsQueue.service");

async function retryFailedCampaign(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const baseCampaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!baseCampaign) throw new HttpError(404, "Campaign not found");
    const template = await templatesRepository.getTemplateById({ id: baseCampaign.templateId, workspaceId: req.workspace.id });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");

    const workspaceObjectId = new mongoose.Types.ObjectId(req.workspace.id);
    const failedRows = await messagesRepository.aggregateMessages([
        { $match: { workspaceId: workspaceObjectId, campaignId: baseCampaign._id, direction: "outbound", status: { $in: ["failed", "timeout_unknown"] } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$phone", phone: { $first: "$phone" }, runtime: { $first: "$payload.runtime" } } },
    ]);

    const normalizedRecipients = normalizeRecipients(failedRows.map((row) => ({
        to: String(row.phone || ""),
        variables: Array.isArray(row.runtime?.variables) ? row.runtime.variables : [],
        headerVariables: Array.isArray(row.runtime?.headerVariables) ? row.runtime.headerVariables : [],
        otpCode: row.runtime?.otpCode ? String(row.runtime.otpCode) : "",
        buttonValues: Array.isArray(row.runtime?.buttonValues) ? row.runtime.buttonValues : [],
        buttonTtlMinutes: Array.isArray(row.runtime?.buttonTtlMinutes) ? row.runtime.buttonTtlMinutes : [],
        flowTokens: Array.isArray(row.runtime?.flowTokens) ? row.runtime.flowTokens : [],
        flowActionData: Array.isArray(row.runtime?.flowActionData) ? row.runtime.flowActionData : [],
    })));
    if (!normalizedRecipients.length) throw new HttpError(400, "No failed recipients found for retry");

    const estimate = await computeCampaignEstimate({ workspaceId: req.workspace.id, template, recipients: normalizedRecipients });
    const { openWindowSet: _openWindowSet, ...publicEstimate } = estimate;
    const { billableRecipients: billableCount, freeRecipients: freeCount, estimatedCredits } = estimate;
    if (walletChargesEnabled() && estimatedCredits > 0) {
        try { await ensureBalance(req.workspace.id, estimatedCredits); } catch (err) {
            if (err instanceof HttpError && err.statusCode === 402) {
                const wallet = await getOrCreateWallet(req.workspace.id);
                throw new HttpError(402, "Insufficient wallet balance for retry campaign", { balance: wallet.balance, required: estimatedCredits, billableRecipients: billableCount, freeRecipients: freeCount, totalRecipients: normalizedRecipients.length });
            }
            throw err;
        }
    }

    const retryCampaign = await campaignsRepository.createCampaign({
        workspaceId: req.workspace.id,
        name: `Retry - ${baseCampaign.name}`.slice(0, 140),
        templateId: template._id,
        status: CAMPAIGN_STATUSES.QUEUED,
        type: CAMPAIGN_TYPES.BROADCAST,
        totals: { total: normalizedRecipients.length, queued: normalizedRecipients.length, sent: 0, failed: 0 },
    });
    await enqueueCampaignRecipients({ workspaceId: req.workspace.id, campaignId: retryCampaign._id, templateId: template._id, recipients: normalizedRecipients, delayMs: 0 });
    emitCampaignEvent(CAMPAIGN_EVENTS.CREATED, { campaignId: String(retryCampaign._id), workspaceId: req.workspace.id });
    return { success: true, campaign: retryCampaign, creditEstimate: publicEstimate };
}

async function listFailedRecipients(req) {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) throw new HttpError(400, "Invalid campaign id");
    const campaign = await campaignsRepository.getCampaignById({ id, workspaceId: req.workspace.id });
    if (!campaign) throw new HttpError(404, "Campaign not found");
    const phones = await messagesRepository.distinctPhones({
        workspaceId: campaign.workspaceId,
        campaignId: campaign._id,
        direction: "outbound",
        status: { $in: ["failed", "timeout_unknown"] },
    });
    const normalized = (phones || []).map((p) => String(p || "").replace(/\D/g, "")).filter((p) => p.length >= 8);
    return { success: true, campaignId: String(campaign._id), phones: normalized };
}

module.exports = { retryFailedCampaign, listFailedRecipients };
