const { HttpError } = require("@shared/utils/httpError");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { contactsRepository, templatesRepository } = require("@modules/campaigns/repositories/index");
const { getOrCreateWallet, roundCurrency } = require("@modules/wallet/services/wallet.core.service");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { buildAttributeAudienceClauses } = require("@modules/campaigns/utils/attributeAudience");
const { contactListsRepository } = require("@modules/contacts/repositories");
const { audiencesRepository } = require("@modules/audiences/repositories");
const { previewContacts } = require("@modules/audiences/services/filterEngine.service");

function normalizeAudience(input) {
    const tags = Array.from(new Set((input?.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
    return {
        mode: ["tags", "attributes", "list", "audience"].includes(String(input?.mode || "").toLowerCase()) ? String(input.mode).toLowerCase() : "manual",
        listId: input?.listId || null,
        audienceId: input?.audienceId || input?.listId || null,
        tags,
        tagMatch: String(input?.tagMatch || "all").toLowerCase() === "any" ? "any" : "all",
        attributeFilters: Array.isArray(input?.attributeFilters) ? input.attributeFilters : [],
        runtime: input?.runtime && typeof input.runtime === "object" ? input.runtime : {},
    };
}

async function resolveAudienceRecipients({ workspaceId, wabaId, audience }) {
    if (!audience.audienceId) throw new HttpError(400, "Select a saved audience");
    const storedAudience = await audiencesRepository.getAudienceLean({ id: audience.audienceId, workspaceId, wabaId });
    if (storedAudience) {
        if (storedAudience.type === "dynamic") {
            const preview = await previewContacts({ workspaceId, wabaId, filterTree: storedAudience.filterTree, page: 1, limit: 100 });
            return (preview.contacts || []).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime));
        }
        const contacts = await contactsRepository.findContactsByIds({ workspaceId, wabaId, contactIds: storedAudience.contactIds || [] });
        return (contacts || []).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime));
    }
    const legacyList = await contactListsRepository.getContactListLean({ id: audience.audienceId, workspaceId, wabaId });
    if (!legacyList) throw new HttpError(404, "Saved audience not found");
    const contacts = await contactsRepository.findContactsByIds({ workspaceId, wabaId, contactIds: legacyList.contactIds || [] });
    return (contacts || []).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime));
}

function buildRecipientFromRuntime(to, runtime) {
    return {
        to,
        variables: Array.isArray(runtime?.variables) ? runtime.variables : [],
        headerVariables: Array.isArray(runtime?.headerVariables) ? runtime.headerVariables : [],
        headerLocation: runtime?.headerLocation && typeof runtime.headerLocation === "object" ? {
            latitude: Number(runtime.headerLocation.latitude),
            longitude: Number(runtime.headerLocation.longitude),
            name: String(runtime.headerLocation.name || ""),
            address: String(runtime.headerLocation.address || ""),
        } : undefined,
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
        : audience.mode === "list" || audience.mode === "audience"
            ? await resolveAudienceRecipients({ workspaceId: req.workspace.id, wabaId: template.wabaId, audience })
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
