const { CAMPAIGN_AUDIENCE_MODES, CAMPAIGN_EVENTS, CAMPAIGN_STATUSES, CAMPAIGN_SCHEDULE_FREQUENCIES } = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent } = require("@modules/campaigns/events/campaign.events");
const { campaignsRepository, contactsRepository } = require("@modules/campaigns/repositories/index");
const { getNextRunAt } = require("@modules/campaigns/utils/schedule");
const { enqueueCampaignRecipients, enqueueScheduledCampaignDispatch } = require("@modules/campaigns/services/campaignsQueue.service");

function isStoppedStatus(status) {
    return [
        CAMPAIGN_STATUSES.CANCELED,
        CAMPAIGN_STATUSES.CANCELLED,
        CAMPAIGN_STATUSES.COMPLETED,
        CAMPAIGN_STATUSES.FAILED,
    ].includes(String(status || "").toLowerCase());
}

function normalizeRecipientSnapshot(recipients) {
    return Array.isArray(recipients)
        ? recipients
            .map((recipient) => ({
                to: String(recipient?.to || "").trim(),
                variables: Array.isArray(recipient?.variables) ? recipient.variables : [],
                headerVariables: Array.isArray(recipient?.headerVariables) ? recipient.headerVariables : [],
                otpCode: recipient?.otpCode || undefined,
                buttonValues: Array.isArray(recipient?.buttonValues) ? recipient.buttonValues : [],
                buttonTtlMinutes: Array.isArray(recipient?.buttonTtlMinutes) ? recipient.buttonTtlMinutes : [],
                flowTokens: Array.isArray(recipient?.flowTokens) ? recipient.flowTokens : [],
                flowActionData: Array.isArray(recipient?.flowActionData) ? recipient.flowActionData : [],
            }))
            .filter((recipient) => recipient.to)
        : [];
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

async function resolveCampaignRecipients(campaign) {
    const audience = campaign.audience || {};
    if (audience.mode !== CAMPAIGN_AUDIENCE_MODES.TAGS) {
        return normalizeRecipientSnapshot(campaign.recipientSnapshot);
    }
    const tags = Array.from(new Set((audience.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
    if (!tags.length) return [];
    const contacts = await contactsRepository.findContactsByTags({
        workspaceId: campaign.workspaceId,
        wabaId: campaign.wabaId,
        tags,
        tagMatch: audience.tagMatch,
    });
    return (contacts || []).map((contact) => buildRecipientFromRuntime(String(contact.phone || ""), audience.runtime));
}

async function scheduleNextCampaignDispatch({ workspaceId, campaignId, runAt }) {
    if (!runAt) return null;
    const runDate = new Date(runAt);
    if (Number.isNaN(runDate.getTime())) return null;
    const job = await enqueueScheduledCampaignDispatch({ workspaceId, campaignId, runAt: runDate });
    emitCampaignEvent(CAMPAIGN_EVENTS.SCHEDULED, {
        workspaceId,
        campaignId: String(campaignId),
        runAt: runDate.toISOString(),
    });
    return job;
}

async function dispatchScheduledCampaign({ workspaceId, campaignId, runAt }) {
    const campaign = await campaignsRepository.findCampaignForScheduledDispatch({ campaignId, workspaceId });
    if (!campaign) return { ok: true, skipped: true, reason: "campaign_not_found" };

    const schedule = campaign.schedule || {};
    if (schedule.status !== "active") return { ok: true, skipped: true, reason: "schedule_inactive" };
    if (String(campaign.status || "").toLowerCase() === CAMPAIGN_STATUSES.PAUSED) {
        return { ok: true, skipped: true, status: campaign.status };
    }
    if (isStoppedStatus(campaign.status)) return { ok: true, skipped: true, status: campaign.status };
    if (
        schedule.frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.DAILY &&
        schedule.frequency !== CAMPAIGN_SCHEDULE_FREQUENCIES.WEEKLY
    ) {
        return { ok: true, skipped: true, reason: "not_recurring" };
    }

    const expectedRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
    const payloadRunAt = runAt ? new Date(runAt) : expectedRunAt;
    if (
        expectedRunAt &&
        payloadRunAt &&
        !Number.isNaN(payloadRunAt.getTime()) &&
        Math.abs(expectedRunAt.getTime() - payloadRunAt.getTime()) > 1000
    ) {
        return { ok: true, skipped: true, reason: "stale_dispatch" };
    }

    const recipients = await resolveCampaignRecipients(campaign);
    if (!recipients.length) {
        await campaignsRepository.updateCampaign(
            { _id: campaign._id, workspaceId },
            {
                $set: {
                    status: CAMPAIGN_STATUSES.FAILED,
                    "schedule.status": "completed",
                    lastError: { message: "Recurring campaign has no matching recipients" },
                },
            }
        );
        return { ok: false, failed: true, reason: "missing_recipients" };
    }

    const now = new Date();
    const nextOccurrencesRun = Number(schedule.occurrencesRun || 0) + 1;
    const nextRunAt = getNextRunAt({
        lastRunAt: expectedRunAt || now,
        frequency: schedule.frequency,
        endAt: schedule.endAt,
        maxOccurrences: schedule.maxOccurrences,
        occurrencesRun: nextOccurrencesRun,
        now,
    });

    await campaignsRepository.updateCampaign(
        { _id: campaign._id, workspaceId },
        {
            $set: {
                status: CAMPAIGN_STATUSES.RUNNING,
                scheduledAt: expectedRunAt || now,
                "schedule.lastRunAt": expectedRunAt || now,
                "schedule.nextRunAt": nextRunAt || null,
                "schedule.occurrencesRun": nextOccurrencesRun,
                "schedule.status": nextRunAt ? "active" : "completed",
            },
            $inc: {
                "totals.total": recipients.length,
                "totals.queued": recipients.length,
            },
            $unset: { lastError: 1 },
        }
    );

    await enqueueCampaignRecipients({
        workspaceId,
        campaignId: campaign._id,
        templateId: campaign.templateId,
        recipients,
        delayMs: 0,
    });
    emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, { workspaceId, campaignId: String(campaign._id) });

    if (nextRunAt) {
        await scheduleNextCampaignDispatch({ workspaceId, campaignId: campaign._id, runAt: nextRunAt });
    }

    return {
        ok: true,
        campaignId: String(campaign._id),
        queued: recipients.length,
        nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    };
}

async function recoverScheduledCampaignDispatches({ limit } = {}) {
    const max = Math.min(Math.max(Number(limit || process.env.CAMPAIGN_SCHEDULE_RECOVERY_LIMIT || 1000), 1), 5000);
    const campaigns = await campaignsRepository.listActiveScheduledCampaigns({ limit: max });
    const results = await Promise.allSettled(
        campaigns.map((campaign) =>
            scheduleNextCampaignDispatch({
                workspaceId: String(campaign.workspaceId),
                campaignId: campaign._id,
                runAt: campaign.schedule?.nextRunAt,
            })
        )
    );
    return {
        scanned: campaigns.length,
        scheduled: results.filter((result) => result.status === "fulfilled").length,
        failed: results.filter((result) => result.status === "rejected").length,
    };
}

module.exports = { scheduleNextCampaignDispatch, dispatchScheduledCampaign, recoverScheduledCampaignDispatches };
