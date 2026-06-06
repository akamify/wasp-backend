const { HttpError } = require("@shared/utils/httpError");
const { Message } = require("@infra/database/Message");
const { CAMPAIGN_AUDIENCE_MODES, CAMPAIGN_STATUSES, CAMPAIGN_TYPES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { normalizeScheduleInput } = require("@modules/campaigns/utils/schedule");
const { campaignsRepository, contactsRepository, templatesRepository } = require("@modules/campaigns/repositories/index");
const { debit, credit, ensureBalance, getOrCreateWallet } = require("@modules/wallet/services/wallet.core.service");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { enqueueCampaignRecipients, hasCampaignWorkers } = require("@modules/campaigns/services/campaignsQueue.service");
const { scheduleNextCampaignDispatch } = require("@modules/campaigns/services/campaignScheduler.service");
const { enforceMonthlyLimit } = require("@modules/billing/services/usageLimit.service");
const { subscriptionRepository } = require("@modules/billing/repositories");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { validateBeforeSend } = require("@shared/utils/templateStructure");
const { buildAttributeAudienceClauses } = require("@modules/campaigns/utils/attributeAudience");
const { resolveRecipientRuntime } = require("@modules/campaigns/utils/templateVariableResolver");
const { contactAttributesRepository } = require("@modules/contacts/repositories");

function buildStoredSendError(err) {
    const metaError = err?.metaDebug?.meta || err?.metaDebug?.raw?.error || err?.response?.data?.error || {};
    const providerMessage =
        metaError?.error_data?.details ||
        metaError?.error_user_msg ||
        metaError?.message ||
        err?.providerError ||
        null;
    return {
        message: err?.message || "Meta send message failed",
        providerMessage,
        providerCode: metaError?.code || null,
        providerSubcode: metaError?.error_subcode || null,
        traceId: metaError?.fbtrace_id || null,
        metaDebug: err?.metaDebug || null,
        raw: err?.response?.data || null,
    };
}

function normalizeAudience(input) {
    const mode = String(input?.mode || CAMPAIGN_AUDIENCE_MODES.MANUAL).toLowerCase();
    const tags = Array.from(new Set((input?.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
    return {
        mode: [CAMPAIGN_AUDIENCE_MODES.TAGS, CAMPAIGN_AUDIENCE_MODES.ATTRIBUTES].includes(mode) ? mode : CAMPAIGN_AUDIENCE_MODES.MANUAL,
        tags,
        tagMatch: String(input?.tagMatch || "all").toLowerCase() === "any" ? "any" : "all",
        attributeFilters: Array.isArray(input?.attributeFilters) ? input.attributeFilters : [],
        runtime: input?.runtime && typeof input.runtime === "object" ? input.runtime : null,
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

async function resolveTagRecipients({ workspaceId, wabaId, audience }) {
    const contacts = await contactsRepository.findContactsByTags({ workspaceId, wabaId, tags: audience.tags, tagMatch: audience.tagMatch });
    return (contacts || []).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime));
}

async function resolveAttributeRecipients({ workspaceId, wabaId, audience }) {
    const filters = await buildAttributeAudienceClauses({ workspaceId, filters: audience.attributeFilters });
    const contacts = await contactsRepository.findContactsByAttributeFilters({ workspaceId, wabaId, filters });
    return (contacts || []).map((contact) => ({ contact, recipient: buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime) }));
}

async function resolveMappingsForRecipients({ workspaceId, wabaId, recipients, mappings }) {
    const hasMappings = mappings.body.length || mappings.header.length || mappings.button.length;
    if (!hasMappings) return { recipients, skipped: [] };
    const phones = recipients.map((recipient) => recipient.to);
    const contacts = await contactsRepository.findContactsByPhones({ workspaceId, wabaId, phones });
    const byPhone = new Map((contacts || []).map((contact) => [String(contact.phone), contact]));
    const resolved = [];
    const skipped = [];
    for (const recipient of recipients) {
        const result = resolveRecipientRuntime({ contact: byPhone.get(String(recipient.to)), recipient, mappings });
        if (result.missing.length) {
            skipped.push({ to: recipient.to, reason: "missing_variable", missing: result.missing });
        } else {
            resolved.push(result.recipient);
        }
    }
    return { recipients: resolved, skipped };
}

async function validateMappings({ workspaceId, mappings }) {
    const all = [...mappings.body, ...mappings.header, ...mappings.button];
    const contactFields = new Set(["name", "phone", "email", "company", "language"]);
    const definitions = await contactAttributesRepository.listDefinitions({ workspaceId, includeInactive: false });
    const activeKeys = new Set(definitions.filter((definition) => definition.visible).map((definition) => definition.key));
    for (const mapping of all) {
        if (mapping.sourceType === "contact_field" && !contactFields.has(mapping.sourceKey)) {
            throw new HttpError(400, `Invalid contact field mapping '${mapping.sourceKey || ""}'`);
        }
        if (mapping.sourceType === "contact_attribute" && !activeKeys.has(mapping.sourceKey)) {
            throw new HttpError(400, `Attribute '${mapping.sourceKey || ""}' is not active and visible`);
        }
    }
}

async function createCampaign(req) {
    await enforceMonthlyLimit({
        workspaceId: req.workspace.id,
        limitKey: "maxCampaignsPerMonth",
        errorMessage: "Monthly campaign create limit reached for your current plan",
        countInWindow: (start, end) =>
            campaignsRepository.countCampaignsCreatedBetween({ workspaceId: req.workspace.id, start, end }),
    });

    const { name, templateId, recipients, scheduledAt, type, schedule } = req.body;
    const activeSubscription = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
    const template = await templatesRepository.getTemplateById({ id: templateId, workspaceId: req.workspace.id });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId: req.workspace.id });
    const audience = normalizeAudience(req.body?.audience);
    if (audience.mode === CAMPAIGN_AUDIENCE_MODES.TAGS && !audience.tags.length) {
        throw new HttpError(400, "Select at least one audience tag");
    }
    if (audience.mode === CAMPAIGN_AUDIENCE_MODES.ATTRIBUTES && !audience.attributeFilters.length) {
        throw new HttpError(400, "Select at least one attribute filter");
    }
    let audienceContactRecipients = null;
    let normalizedRecipients = audience.mode === CAMPAIGN_AUDIENCE_MODES.TAGS
        ? await resolveTagRecipients({ workspaceId: req.workspace.id, wabaId: template.wabaId, audience })
        : audience.mode === CAMPAIGN_AUDIENCE_MODES.ATTRIBUTES
            ? (audienceContactRecipients = await resolveAttributeRecipients({ workspaceId: req.workspace.id, wabaId: template.wabaId, audience })).map((item) => item.recipient)
            : normalizeRecipients(recipients);
    const mappings = {
        body: req.body.templateVariableMappings || [],
        header: req.body.headerVariableMappings || [],
        button: req.body.buttonVariableMappings || [],
    };
    await validateMappings({ workspaceId: req.workspace.id, mappings });
    const mappingResult = audienceContactRecipients
        ? (() => {
            const resolved = [], skipped = [];
            for (const item of audienceContactRecipients) {
                const result = resolveRecipientRuntime({ contact: item.contact, recipient: item.recipient, mappings });
                if (result.missing.length) skipped.push({ to: item.recipient.to, reason: "missing_variable", missing: result.missing });
                else resolved.push(result.recipient);
            }
            return { recipients: resolved, skipped };
        })()
        : await resolveMappingsForRecipients({ workspaceId: req.workspace.id, wabaId: template.wabaId, recipients: normalizedRecipients, mappings });
    normalizedRecipients = mappingResult.recipients;
    const normalizedType = String(type || CAMPAIGN_TYPES.BROADCAST).toLowerCase();
    if (audience.mode !== CAMPAIGN_AUDIENCE_MODES.MANUAL && normalizedType !== CAMPAIGN_TYPES.BROADCAST) {
        throw new HttpError(400, "Tag and attribute audiences are only supported for broadcast campaigns");
    }
    const normalizedSchedule = normalizeScheduleInput({ scheduledAt, schedule });
    if (normalizedSchedule.isRecurring && normalizedType === CAMPAIGN_TYPES.API) {
        throw new HttpError(400, "Recurring schedule is only supported for broadcast and CSV campaigns");
    }
    const hasCampaignApiAccess = !isPlanRestrictionsEnabled()
        ? true
        : activeSubscription
            ? Boolean(activeSubscription?.snapshot?.features?.campaignApiAccess)
            : false;
    if (normalizedType === CAMPAIGN_TYPES.API && !hasCampaignApiAccess) {
        throw new HttpError(403, "Your current plan does not allow API campaigns");
    }
    if (normalizedType === CAMPAIGN_TYPES.API) {
        if (normalizedRecipients.length > 0) throw new HttpError(400, "API campaigns should not include recipients. Provide contacts when sending via integrations.");
        const campaign = await campaignsRepository.createCampaign({ workspaceId: req.workspace.id, wabaId: template.wabaId, name, templateId: template._id, status: CAMPAIGN_STATUSES.RUNNING, type: CAMPAIGN_TYPES.API, scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined, totals: { total: 0, queued: 0, sent: 0, failed: 0 } });
        emitCampaignEvent(CAMPAIGN_EVENTS.CREATED, { campaignId: String(campaign._id), workspaceId: req.workspace.id });
        return { success: true, campaign, message: "API campaign created. Contacts will be provided by integrations at send time." };
    }
    const canResolveDynamicAudienceAtRun =
        normalizedSchedule.isScheduled &&
        audience.mode !== CAMPAIGN_AUDIENCE_MODES.MANUAL;
    if (normalizedRecipients.length === 0 && !canResolveDynamicAudienceAtRun) {
        throw new HttpError(400, mappingResult.skipped.length ? "All recipients are missing required template variables" : "At least one recipient required", {
            skippedRecipients: mappingResult.skipped.length,
            missingVariablePreview: mappingResult.skipped.slice(0, 5),
        });
    }
    normalizedRecipients.forEach((recipient) => validateBeforeSend(template, recipient));
    const estimate = await computeCampaignEstimate({ workspaceId: req.workspace.id, template, recipients: normalizedRecipients });
    const { openWindowSet: _openWindowSet, ...publicEstimate } = estimate;
    const { billableRecipients: billableCount, freeRecipients: freeCount, estimatedCredits } = estimate;
    if (estimatedCredits > 0) {
        try { await ensureBalance(req.workspace.id, estimatedCredits); } catch (err) {
            if (err instanceof HttpError && err.statusCode === 402) {
                const wallet = await getOrCreateWallet(req.workspace.id);
                throw new HttpError(402, "Insufficient wallet balance for this campaign", { balance: wallet.balance, required: estimatedCredits, billableRecipients: billableCount, freeRecipients: freeCount, totalRecipients: normalizedRecipients.length });
            }
            throw err;
        }
    }
    const campaign = await campaignsRepository.createCampaign({
        workspaceId: req.workspace.id, wabaId: template.wabaId, name, templateId: template._id,
        status: CAMPAIGN_STATUSES.QUEUED,
        type: normalizedType || CAMPAIGN_TYPES.BROADCAST,
        scheduledAt: normalizedSchedule.isScheduled ? normalizedSchedule.nextRunAt : undefined,
        audience: {
            mode: audience.mode,
            tags: audience.tags,
            tagMatch: audience.tagMatch,
            attributeFilters: audience.attributeFilters,
            runtime: audience.runtime || undefined,
        },
        templateVariableMappings: mappings.body,
        headerVariableMappings: mappings.header,
        buttonVariableMappings: mappings.button,
        schedule: normalizedSchedule.isScheduled ? normalizedSchedule : undefined,
        recipientSnapshot: normalizedSchedule.isScheduled && audience.mode === CAMPAIGN_AUDIENCE_MODES.MANUAL
            ? await (async () => {
                const contacts = await contactsRepository.findContactsByPhones({
                    workspaceId: req.workspace.id,
                    wabaId: template.wabaId,
                    phones: normalizedRecipients.map((recipient) => recipient.to),
                    select: "_id phone",
                });
                const contactIdByPhone = new Map(
                    (contacts || []).map((contact) => [String(contact.phone), contact._id])
                );
                return normalizedRecipients.map((recipient) => ({
                    ...recipient,
                    contactId: contactIdByPhone.get(String(recipient.to)),
                }));
            })()
            : undefined,
        totals: normalizedSchedule.isScheduled
            ? { total: 0, queued: 0, sent: 0, failed: 0 }
            : { total: normalizedRecipients.length, queued: normalizedRecipients.length, sent: 0, failed: 0 },
    });
    emitCampaignEvent(CAMPAIGN_EVENTS.CREATED, { campaignId: String(campaign._id), workspaceId: req.workspace.id });
    if (normalizedSchedule.isScheduled) {
        await scheduleNextCampaignDispatch({
            workspaceId: req.workspace.id,
            campaignId: campaign._id,
            runAt: normalizedSchedule.nextRunAt,
        });
        return { success: true, campaign, creditEstimate: publicEstimate };
    }
    const delayMs = campaign.scheduledAt ? Math.max(campaign.scheduledAt.getTime() - Date.now(), 0) : 0;
    if (delayMs > 0) emitCampaignEvent(CAMPAIGN_EVENTS.SCHEDULED, { campaignId: String(campaign._id), delayMs });

    let queuedToRedis = true;
    try { await enqueueCampaignRecipients({ workspaceId: req.workspace.id, campaignId: campaign._id, templateId: template._id, recipients: normalizedRecipients, delayMs }); } catch (queueErr) {
        queuedToRedis = false;
        campaign.lastError = { message: queueErr?.message || "Failed to enqueue campaign jobs" };
        await campaign.save();
    }

    if (delayMs === 0) {
        let hasWorkers = false;
        try { hasWorkers = await hasCampaignWorkers(); } catch { hasWorkers = false; }
        if (!queuedToRedis || !hasWorkers) {
            let sentCount = 0, failedCount = 0, lastFailure = null;
            const openNowSet = estimate.openWindowSet || new Set();
            campaign.status = CAMPAIGN_STATUSES.RUNNING;
            await campaign.save();
            emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, { campaignId: String(campaign._id) });
            for (const recipient of normalizedRecipients) {
                try {
                    const chargeAmount = openNowSet.has(String(recipient.to)) ? 0 : estimate.categoryCost;
                    if (chargeAmount > 0) await debit(req.workspace.id, chargeAmount, "Message send (campaign)", { campaignId: String(campaign._id), templateId: String(template._id), to: recipient.to, pricing: { customerServiceWindowOpen: openNowSet.has(String(recipient.to)), walletChargesEnabled: estimate.walletChargesEnabled } });
                    await sendTemplateMessageForUser({ userId: req.workspace.id, campaignId: String(campaign._id), template, to: recipient.to, variables: recipient.variables, headerVariables: recipient.headerVariables, otpCode: recipient.otpCode, buttonValues: recipient.buttonValues, buttonTtlMinutes: recipient.buttonTtlMinutes, flowTokens: recipient.flowTokens, flowActionData: recipient.flowActionData });
                    sentCount += 1;
                } catch (err) {
                    failedCount += 1;
                    const storedError = buildStoredSendError(err);
                    lastFailure = storedError.providerMessage || storedError.message || "Campaign send failed";
                    try {
                        const now = new Date();
                        await Message.create({ workspaceId: req.workspace.id, wabaId: template.wabaId, campaignId: campaign._id, templateId: template._id, phone: recipient.to, direction: "outbound", status: "failed", statusTimestamps: { failedAt: now }, text: "", payload: { to: recipient.to, template: { id: String(template._id), name: template.name, language: template.language }, runtime: { variables: recipient.variables || [], headerVariables: recipient.headerVariables || [], otpCode: recipient.otpCode || "", buttonValues: recipient.buttonValues || [], buttonTtlMinutes: recipient.buttonTtlMinutes || [], flowTokens: recipient.flowTokens || [], flowActionData: recipient.flowActionData || [] } }, error: storedError });
                    } catch {}
                    try {
                        const chargeAmount = openNowSet.has(String(recipient.to)) ? 0 : estimate.categoryCost;
                        if (err?.response && chargeAmount > 0) await credit(req.workspace.id, chargeAmount, "Message refund (campaign failed)", "internal", "", { campaignId: String(campaign._id), templateId: String(template._id), to: recipient.to });
                    } catch {}
                }
            }
            campaign.totals.queued = 0; campaign.totals.sent = sentCount; campaign.totals.failed = failedCount;
            campaign.status = failedCount > 0 ? (sentCount > 0 ? "completed" : "failed") : "completed";
            if (failedCount > 0 && lastFailure) campaign.lastError = { message: String(lastFailure) };
            await campaign.save();
            emitCampaignEvent(failedCount > 0 ? CAMPAIGN_EVENTS.FAILED : CAMPAIGN_EVENTS.COMPLETED, { campaignId: String(campaign._id) });
        }
    }
    return {
        success: true,
        campaign,
        creditEstimate: publicEstimate,
        resolution: {
            totalRecipients: normalizedRecipients.length + mappingResult.skipped.length,
            resolvedRecipients: normalizedRecipients.length,
            skippedRecipients: mappingResult.skipped.length,
            skippedReasons: mappingResult.skipped.length ? { missing_variable: mappingResult.skipped.length } : {},
            missingVariablePreview: mappingResult.skipped.slice(0, 5),
        },
    };
}

module.exports = { createCampaign };
