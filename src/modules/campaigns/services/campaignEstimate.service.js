const { HttpError } = require("@shared/utils/httpError");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { contactsRepository, templatesRepository } = require("@modules/campaigns/repositories/index");
const { getOrCreateWallet, roundCurrency } = require("@modules/wallet/services/wallet.core.service");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { buildAttributeAudienceClauses } = require("@modules/campaigns/utils/attributeAudience");

function normalizeAudience(input) {
    const tags = Array.from(new Set((input?.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
    return {
        mode: ["tags", "attributes"].includes(String(input?.mode || "").toLowerCase()) ? String(input.mode).toLowerCase() : "manual",
        tags,
        tagMatch: String(input?.tagMatch || "all").toLowerCase() === "any" ? "any" : "all",
        attributeFilters: Array.isArray(input?.attributeFilters) ? input.attributeFilters : [],
        runtime: input?.runtime && typeof input.runtime === "object" ? input.runtime : {},
    };
}

function buildRecipientFromRuntime(to, runtime) {
    return {
        to,
        variables: Array.isArray(runtime?.variables) ? runtime.variables : [],
        headerVariables: Array.isArray(runtime?.headerVariables) ? runtime.headerVariables : [],
        otpCode: runtime?.otpCode || undefined,
        buttonValues: Array.isArray(runtime?.buttonValues) ? runtime.buttonValues : [],
        buttonTtlMinutes: Array.isArray(runtime?.buttonTtlMinutes) ? runtime.buttonTtlMinutes : [],
        flowTokens: Array.isArray(runtime?.flowTokens) ? runtime.flowTokens : [],
        flowActionData: Array.isArray(runtime?.flowActionData) ? runtime.flowActionData : [],
    };
}

async function estimateCampaign(req) {
    const { templateId, recipients } = req.body;
    const template = await templatesRepository.getTemplateById({ id: templateId, workspaceId: req.workspace.id });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId: req.workspace.id });
    const audience = normalizeAudience(req.body?.audience);
    const normalizedRecipients = audience.mode === "tags"
        ? (await contactsRepository.findContactsByTags({
            workspaceId: req.workspace.id,
            wabaId: template.wabaId,
            tags: audience.tags,
            tagMatch: audience.tagMatch,
        })).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime))
        : audience.mode === "attributes"
            ? (await contactsRepository.findContactsByAttributeFilters({
                workspaceId: req.workspace.id,
                wabaId: template.wabaId,
                filters: await buildAttributeAudienceClauses({ workspaceId: req.workspace.id, filters: audience.attributeFilters }),
            })).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime))
        : normalizeRecipients(recipients);
    if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");
    const estimate = await computeCampaignEstimate({ workspaceId: req.workspace.id, template, recipients: normalizedRecipients });
    const { openWindowSet: _openWindowSet, ...publicEstimate } = estimate;
    const wallet = await getOrCreateWallet(req.workspace.id);
    const walletBalance = roundCurrency(wallet.balance || 0);
    const estimatedCredits = roundCurrency(estimate.estimatedCredits || 0);
    const insufficient = estimatedCredits > walletBalance;
    return { success: true, estimate: { ...publicEstimate, estimatedCredits, walletBalance, currency: wallet.currency || "INR", insufficientBalance: insufficient } };
}

module.exports = { estimateCampaign };
