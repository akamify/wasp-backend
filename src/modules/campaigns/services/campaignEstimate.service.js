const { HttpError } = require("@shared/utils/httpError");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { templatesRepository } = require("@modules/campaigns/repositories/index");
const { getOrCreateWallet, roundCurrency, walletChargesEnabled } = require("@modules/wallet/services/wallet.core.service");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");

async function estimateCampaign(req) {
    const { templateId, recipients } = req.body;
    const template = await templatesRepository.getTemplateById({ id: templateId, workspaceId: req.workspace.id });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId: req.workspace.id });
    const normalizedRecipients = normalizeRecipients(recipients);
    if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");
    const estimate = await computeCampaignEstimate({ workspaceId: req.workspace.id, template, recipients: normalizedRecipients });
    const { openWindowSet: _openWindowSet, ...publicEstimate } = estimate;
    const wallet = await getOrCreateWallet(req.workspace.id);
    const walletBalance = roundCurrency(wallet.balance || 0);
    const estimatedCredits = roundCurrency(estimate.estimatedCredits || 0);
    const insufficient = walletChargesEnabled() && estimatedCredits > walletBalance;
    return { success: true, estimate: { ...publicEstimate, estimatedCredits, walletBalance, currency: wallet.currency || "INR", insufficientBalance: insufficient } };
}

module.exports = { estimateCampaign };
