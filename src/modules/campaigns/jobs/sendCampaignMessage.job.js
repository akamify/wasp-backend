const { Campaign } = require("@infra/database/Campaign");
const { Template } = require("@infra/database/Template");
const { Message } = require("@infra/database/Message");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { debit, credit, messageCostForTemplateCategory } = require("@modules/wallet/services/wallet.core.service");
const { isCustomerServiceWindowOpen } = require("@shared/services/pricingService");
const { CAMPAIGN_STATUSES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");

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

function isFinalAttempt(job) {
    const attempts = Math.max(Number(job?.opts?.attempts || 1), 1);
    const currentAttemptNumber = Number(job?.attemptsMade || 0) + 1;
    return currentAttemptNumber >= attempts;
}

async function finalizeCampaignIfDone({ workspaceId, campaignId }) {
    try {
        const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("status totals type").lean();
        if (!campaign) return;
        if (String(campaign.type || "") === "api") return;
        const queued = Number(campaign?.totals?.queued || 0);
        if (queued > 0) return;
        const status = String(campaign.status || "");
        if (![CAMPAIGN_STATUSES.DRAFT, CAMPAIGN_STATUSES.QUEUED, CAMPAIGN_STATUSES.RUNNING].includes(status)) return;
        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $set: { status: CAMPAIGN_STATUSES.COMPLETED } });
        emitCampaignEvent(CAMPAIGN_EVENTS.COMPLETED, { campaignId: String(campaignId), workspaceId });
    } catch { }
}

async function sendCampaignMessageJob(job) {
    const {
        workspaceId,
        campaignId,
        templateId,
        to,
        variables,
        headerVariables,
        otpCode,
        buttonValues,
        buttonTtlMinutes,
        flowTokens,
        flowActionData,
    } = job.data || {};
    if (!workspaceId || !campaignId || !templateId || !to) {
        throw new Error("Invalid job payload");
    }

    const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("status totals wabaId");
    if (!campaign) return { ok: true, skipped: true, reason: "campaign_not_found" };
    const status = String(campaign.status || "");
    if (
        status === CAMPAIGN_STATUSES.PAUSED ||
        status === CAMPAIGN_STATUSES.CANCELED ||
        status === CAMPAIGN_STATUSES.CANCELLED ||
        status === CAMPAIGN_STATUSES.COMPLETED ||
        status === CAMPAIGN_STATUSES.FAILED
    ) {
        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $inc: { "totals.queued": -1 } });
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true, skipped: true, status };
    }

    if (status === CAMPAIGN_STATUSES.QUEUED) {
        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $set: { status: CAMPAIGN_STATUSES.RUNNING } });
        emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, { campaignId: String(campaignId), workspaceId });
    }

    const updatedStatus = status === CAMPAIGN_STATUSES.QUEUED ? CAMPAIGN_STATUSES.RUNNING : status;
    if (updatedStatus !== CAMPAIGN_STATUSES.RUNNING) {
        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $inc: { "totals.queued": -1 } });
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true, skipped: true, status: updatedStatus };
    }

    const template = await Template.findOne({ _id: templateId, workspaceId, wabaId: campaign.wabaId });
    if (!template) throw new Error("Template not found");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId });

    const windowOpen = await isCustomerServiceWindowOpen({ workspaceId, phone: to });
    const chargeAmount = windowOpen ? 0 : messageCostForTemplateCategory(template.category, 1);
    try {
        if (chargeAmount > 0) {
            await debit(workspaceId, chargeAmount, "Message send (campaign)", { campaignId, templateId, to });
        }
        await sendTemplateMessageForUser({
            userId: workspaceId,
            campaignId,
            template,
            to,
            variables,
            headerVariables,
            otpCode,
            buttonValues,
            buttonTtlMinutes,
            flowTokens,
            flowActionData,
        });

        await Campaign.updateOne({ _id: campaignId, workspaceId }, { $inc: { "totals.queued": -1, "totals.sent": 1 } });
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true };
    } catch (err) {
        const storedError = buildStoredSendError(err);
        if (!isFinalAttempt(job)) {
            throw err;
        }
        try {
            const now = new Date();
            await Message.create({
                workspaceId,
                wabaId: campaign.wabaId,
                campaignId,
                templateId,
                phone: to,
                direction: "outbound",
                status: "failed",
                statusTimestamps: { failedAt: now },
                text: "",
                payload: {
                    to,
                    template: { id: templateId },
                    runtime: {
                        variables: variables || [],
                        headerVariables: headerVariables || [],
                        otpCode: otpCode || "",
                        buttonValues: buttonValues || [],
                        buttonTtlMinutes: buttonTtlMinutes || [],
                        flowTokens: flowTokens || [],
                        flowActionData: flowActionData || [],
                    },
                },
                error: storedError,
            });
        } catch { }
        if (err?.response) {
            try {
                if (chargeAmount > 0) {
                    await credit(workspaceId, chargeAmount, "Message refund (campaign failed)", "internal", "", {
                        campaignId,
                        templateId,
                        to,
                    });
                }
            } catch { }
        }
        await Campaign.updateOne(
            { _id: campaignId, workspaceId },
            {
                $inc: { "totals.queued": -1, "totals.failed": 1 },
                $set: { lastError: { message: storedError.providerMessage || storedError.message } },
            }
        );
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        emitCampaignEvent(CAMPAIGN_EVENTS.FAILED, { campaignId: String(campaignId), workspaceId, reason: storedError.providerMessage || storedError.message });
        return { ok: false, failed: true, error: storedError.providerMessage || storedError.message };
    }
}

module.exports = { sendCampaignMessageJob, finalizeCampaignIfDone };


