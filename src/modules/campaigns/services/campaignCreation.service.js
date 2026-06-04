const { HttpError } = require("@shared/utils/httpError");
const { Message } = require("@infra/database/Message");
const { CAMPAIGN_STATUSES, CAMPAIGN_TYPES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const { buildRecurringSchedule, normalizeScheduleInput } = require("@modules/campaigns/utils/schedule");
const { campaignsRepository, templatesRepository } = require("@modules/campaigns/repositories/index");
const { debit, credit, ensureBalance, getOrCreateWallet } = require("@modules/wallet/services/wallet.core.service");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { enqueueCampaignRecipients, hasCampaignWorkers } = require("@modules/campaigns/services/campaignsQueue.service");
const { scheduleNextCampaignDispatch } = require("@modules/campaigns/services/campaignScheduler.service");
const { enforceMonthlyLimit } = require("@modules/billing/services/usageLimit.service");
const { subscriptionRepository } = require("@modules/billing/repositories");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { validateBeforeSend } = require("@shared/utils/templateStructure");

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
    const normalizedRecipients = normalizeRecipients(recipients);
    const normalizedType = String(type || CAMPAIGN_TYPES.BROADCAST).toLowerCase();
    const normalizedSchedule = normalizeScheduleInput({ scheduledAt, schedule });
    if (normalizedSchedule.isRecurring && normalizedType === CAMPAIGN_TYPES.API) {
        throw new HttpError(400, "Recurring schedule is only supported for broadcast and CSV campaigns");
    }
    if (normalizedSchedule.isRecurring && !normalizedSchedule.startAt) {
        throw new HttpError(400, "scheduledAt is required for recurring campaigns");
    }
    if (
        normalizedSchedule.isRecurring &&
        normalizedSchedule.endAt &&
        normalizedSchedule.startAt &&
        normalizedSchedule.endAt.getTime() < normalizedSchedule.startAt.getTime()
    ) {
        throw new HttpError(400, "schedule.endAt must be after scheduledAt");
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
    if (normalizedRecipients.length === 0) throw new HttpError(400, "At least one recipient required");
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
    const recurringSchedule = buildRecurringSchedule({ scheduledAt, schedule });
    if (normalizedSchedule.isRecurring && !recurringSchedule?.nextRunAt) {
        throw new HttpError(400, "Recurring campaign needs a valid future run time");
    }
    const campaign = await campaignsRepository.createCampaign({
        workspaceId: req.workspace.id, wabaId: template.wabaId, name, templateId: template._id,
        status: normalizedType === CAMPAIGN_TYPES.API && !scheduledAt ? CAMPAIGN_STATUSES.RUNNING : CAMPAIGN_STATUSES.QUEUED,
        type: normalizedType || CAMPAIGN_TYPES.BROADCAST, scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
        schedule: recurringSchedule || undefined,
        recipientSnapshot: recurringSchedule ? normalizedRecipients : undefined,
        totals: recurringSchedule
            ? { total: 0, queued: 0, sent: 0, failed: 0 }
            : { total: normalizedRecipients.length, queued: normalizedRecipients.length, sent: 0, failed: 0 },
    });
    emitCampaignEvent(CAMPAIGN_EVENTS.CREATED, { campaignId: String(campaign._id), workspaceId: req.workspace.id });
    if (recurringSchedule) {
        await scheduleNextCampaignDispatch({
            workspaceId: req.workspace.id,
            campaignId: campaign._id,
            runAt: recurringSchedule.nextRunAt,
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
    return { success: true, campaign, creditEstimate: publicEstimate };
}

module.exports = { createCampaign };
