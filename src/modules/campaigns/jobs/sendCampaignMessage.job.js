const { Campaign } = require("@infra/database/Campaign");
const { Template } = require("@infra/database/Template");
const { Message } = require("@infra/database/Message");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { CAMPAIGN_STATUSES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { campaignRunsRepository } = require("@modules/campaigns/repositories/index");

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

function isNonRetryableSendError(err) {
    const statusCode = Number(err?.statusCode || err?.status || 0);
    return statusCode >= 400 && statusCode < 500;
}

async function finalizeCampaignIfDone({ workspaceId, campaignId }) {
    try {
        const campaign = await Campaign.findOne({ _id: campaignId, workspaceId }).select("status totals type schedule").lean();
        if (!campaign) return;
        if (String(campaign.type || "") === "api") return;
        const queued = Number(campaign?.totals?.queued || 0);
        if (queued > 0) return;
        const status = String(campaign.status || "");
        if (![CAMPAIGN_STATUSES.DRAFT, CAMPAIGN_STATUSES.QUEUED, CAMPAIGN_STATUSES.RUNNING].includes(status)) return;
        const hasNextRecurringRun =
            campaign?.schedule?.status === "active" &&
            campaign?.schedule?.nextRunAt &&
            String(campaign?.schedule?.type || campaign?.schedule?.frequency || "") !== "once";
        await Campaign.updateOne(
            { _id: campaignId, workspaceId },
            { $set: { status: hasNextRecurringRun ? CAMPAIGN_STATUSES.QUEUED : CAMPAIGN_STATUSES.COMPLETED } }
        );
        emitCampaignEvent(hasNextRecurringRun ? CAMPAIGN_EVENTS.SCHEDULED : CAMPAIGN_EVENTS.COMPLETED, { campaignId: String(campaignId), workspaceId });
    } catch { }
}

async function reserveCampaignRunMessage({
    job,
    workspaceId,
    campaignId,
    campaignRunId,
    contactId,
    templateId,
    wabaId,
    to,
    runtime,
}) {
    if (!campaignRunId) return { message: null, duplicate: false };
    const queueJobId = String(job.id || "");
    try {
        const message = await Message.create({
            workspaceId,
            wabaId,
            campaignId,
            campaignRunId,
            ...(contactId ? { contactId } : {}),
            templateId,
            phone: to,
            direction: "outbound",
            status: "processing",
            text: "",
            payload: { to, queueJobId, runtime },
        });
        return { message, duplicate: false };
    } catch (err) {
        if (Number(err?.code) !== 11000) throw err;
        const message = await Message.findOne({
            campaignRunId,
            ...(contactId ? { contactId } : { phone: to }),
        });
        if (!message) throw err;
        const existingJobId = String(message?.payload?.queueJobId || "");
        const finalStatus = ["accepted", "sent", "delivered", "read", "failed"].includes(String(message.status || ""));
        return {
            message,
            duplicate: finalStatus || (existingJobId && existingJobId !== queueJobId),
        };
    }
}

async function finalizeCampaignRunMessage({ messageId, campaignRunId, sent }) {
    if (!messageId || !campaignRunId) return;
    const finalized = await Message.findOneAndUpdate(
        { _id: messageId, campaignRunFinalized: { $ne: true } },
        { $set: { campaignRunFinalized: true } },
        { new: true }
    );
    if (!finalized) return;
    await campaignRunsRepository.finalizeCampaignRunMessage({ runId: campaignRunId, sent });
}

async function sendCampaignMessageJob(job) {
    const {
        workspaceId,
        campaignId,
        campaignRunId,
        contactId,
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

    const runtime = {
        variables: variables || [],
        headerVariables: headerVariables || [],
        otpCode: otpCode || "",
        buttonValues: buttonValues || [],
        buttonTtlMinutes: buttonTtlMinutes || [],
        flowTokens: flowTokens || [],
        flowActionData: flowActionData || [],
    };
    const reservation = await reserveCampaignRunMessage({
        job,
        workspaceId,
        campaignId,
        campaignRunId,
        contactId,
        templateId,
        wabaId: campaign.wabaId,
        to,
        runtime,
    });
    if (reservation.duplicate) {
        return { ok: true, skipped: true, reason: "campaign_run_recipient_already_processed" };
    }
    try {
        await sendTemplateMessageForUser({
            userId: workspaceId,
            campaignId,
            campaignRunId,
            contactId,
            messageId: reservation.message?._id,
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
        await finalizeCampaignRunMessage({
            messageId: reservation.message?._id,
            campaignRunId,
            sent: true,
        });
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        return { ok: true };
    } catch (err) {
        const storedError = buildStoredSendError(err);
        if (!isFinalAttempt(job) && !isNonRetryableSendError(err)) {
            throw err;
        }
        try {
            const now = new Date();
            const failedMessageData = {
                workspaceId,
                wabaId: campaign.wabaId,
                campaignId,
                ...(campaignRunId ? { campaignRunId } : {}),
                ...(contactId ? { contactId } : {}),
                templateId,
                phone: to,
                direction: "outbound",
                status: "failed",
                statusTimestamps: { failedAt: now },
                text: "",
                payload: {
                    to,
                    template: { id: templateId },
                    runtime,
                },
                error: storedError,
            };
            if (reservation.message?._id) {
                await Message.updateOne(
                    { _id: reservation.message._id },
                    { $set: failedMessageData }
                );
            } else {
                await Message.create(failedMessageData);
            }
        } catch { }
        if (Number(err?.statusCode || err?.status) === 402) {
            await Campaign.updateOne(
                { _id: campaignId, workspaceId },
                { $set: { status: CAMPAIGN_STATUSES.FAILED, lastError: { message: "Insufficient wallet balance. Add credits to send templates." } } }
            );
        }
        await Campaign.updateOne(
            { _id: campaignId, workspaceId },
            {
                $inc: { "totals.queued": -1, "totals.failed": 1 },
                $set: { lastError: { message: storedError.providerMessage || storedError.message } },
            }
        );
        await finalizeCampaignRunMessage({
            messageId: reservation.message?._id,
            campaignRunId,
            sent: false,
        });
        await finalizeCampaignIfDone({ workspaceId, campaignId });
        emitCampaignEvent(CAMPAIGN_EVENTS.FAILED, { campaignId: String(campaignId), workspaceId, reason: storedError.providerMessage || storedError.message });
        return { ok: false, failed: true, error: storedError.providerMessage || storedError.message };
    }
}

module.exports = { sendCampaignMessageJob, finalizeCampaignIfDone };


