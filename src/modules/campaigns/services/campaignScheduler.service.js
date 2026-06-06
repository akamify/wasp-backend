const { randomUUID } = require("crypto");
const {
    CAMPAIGN_AUDIENCE_MODES,
    CAMPAIGN_EVENTS,
    CAMPAIGN_STATUSES,
    CAMPAIGN_SCHEDULE_FREQUENCIES,
} = require("@modules/campaigns/constants/campaign.constants");
const { emitCampaignEvent } = require("@modules/campaigns/events/campaign.events");
const {
    campaignsRepository,
    campaignRunsRepository,
    contactsRepository,
} = require("@modules/campaigns/repositories/index");
const { getNextRunAt } = require("@modules/campaigns/utils/schedule");
const {
    enqueueCampaignRecipients,
    enqueueScheduledCampaignDispatch,
} = require("@modules/campaigns/services/campaignsQueue.service");
const { buildAttributeAudienceClauses } = require("@modules/campaigns/utils/attributeAudience");
const { resolveRecipientRuntime } = require("@modules/campaigns/utils/templateVariableResolver");
const logger = require("@core/logger/logger");

const SCHEDULE_LOCK_MS = Math.min(
    Math.max(Number(process.env.CAMPAIGN_SCHEDULE_LOCK_MS || 3 * 60 * 1000), 60 * 1000),
    10 * 60 * 1000
);

function normalizeRecipientSnapshot(recipients) {
    return Array.isArray(recipients)
        ? recipients
            .map((recipient) => ({
                contactId: recipient?.contactId || undefined,
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

function buildRecipientFromRuntime(contact, runtime) {
    return {
        contactId: contact?._id || undefined,
        to: String(contact?.phone || "").trim(),
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
    if (audience.mode === CAMPAIGN_AUDIENCE_MODES.MANUAL) {
        return normalizeRecipientSnapshot(campaign.recipientSnapshot);
    }

    let contacts = [];
    if (audience.mode === CAMPAIGN_AUDIENCE_MODES.TAGS) {
        const tags = Array.from(new Set((audience.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)));
        if (!tags.length) return [];
        contacts = await contactsRepository.findContactsByTags({
            workspaceId: campaign.workspaceId,
            wabaId: campaign.wabaId,
            tags,
            tagMatch: audience.tagMatch,
        });
    } else if (audience.mode === CAMPAIGN_AUDIENCE_MODES.ATTRIBUTES) {
        const filters = await buildAttributeAudienceClauses({
            workspaceId: campaign.workspaceId,
            filters: audience.attributeFilters || [],
        });
        contacts = await contactsRepository.findContactsByAttributeFilters({
            workspaceId: campaign.workspaceId,
            wabaId: campaign.wabaId,
            filters,
        });
    }

    const mappings = {
        body: campaign.templateVariableMappings || [],
        header: campaign.headerVariableMappings || [],
        button: campaign.buttonVariableMappings || [],
    };
    const recipients = [];
    for (const contact of contacts || []) {
        const recipient = buildRecipientFromRuntime(contact, audience.runtime);
        if (!recipient.to) continue;
        const resolved = resolveRecipientRuntime({ contact, recipient, mappings });
        if (!resolved.missing.length) {
            recipients.push({ ...resolved.recipient, contactId: contact._id });
        }
    }
    return recipients;
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

function buildScheduleAdvance(schedule, scheduledFor) {
    const type = String(schedule?.type || schedule?.frequency || "");
    if (type === CAMPAIGN_SCHEDULE_FREQUENCIES.ONCE) {
        return { nextRunAt: null, status: "completed" };
    }
    const nextRunAt = getNextRunAt({
        schedule,
        now: new Date(new Date(scheduledFor).getTime() + 1000),
    });
    return { nextRunAt, status: nextRunAt ? "active" : "completed" };
}

async function releaseFailedDispatch({ campaign, lockedBy, run, err }) {
    if (run?._id) {
        await campaignRunsRepository.markCampaignRunFailed({ runId: run._id, error: err }).catch(() => {});
    }
    await campaignsRepository.releaseScheduledCampaignLock({
        campaignId: campaign._id,
        workspaceId: campaign.workspaceId,
        lockedBy,
        update: {
            $set: {
                lastError: { message: err?.message || String(err || "Scheduled campaign dispatch failed") },
            },
        },
    }).catch(() => {});
}

async function dispatchScheduledCampaign({ workspaceId, campaignId, runAt }) {
    const payloadRunAt = runAt ? new Date(runAt) : null;
    const now = new Date();
    if (payloadRunAt && Number.isNaN(payloadRunAt.getTime())) {
        return { ok: true, skipped: true, reason: "invalid_run_time" };
    }

    const lockedBy = `${process.pid}:${randomUUID()}`;
    const campaign = await campaignsRepository.acquireScheduledCampaignLock({
        campaignId,
        workspaceId,
        now,
        lockUntil: new Date(now.getTime() + SCHEDULE_LOCK_MS),
        lockedBy,
    });
    if (!campaign) {
        logger.info("Campaign schedule skipped because locked or no longer due", { campaignId: String(campaignId) });
        return { ok: true, skipped: true, reason: "locked_or_not_due" };
    }

    const scheduledFor = new Date(campaign.schedule.nextRunAt);
    if (
        payloadRunAt &&
        Math.abs(scheduledFor.getTime() - payloadRunAt.getTime()) > 1000
    ) {
        await campaignsRepository.releaseScheduledCampaignLock({
            campaignId: campaign._id,
            workspaceId: campaign.workspaceId,
            lockedBy,
        });
        return { ok: true, skipped: true, reason: "stale_dispatch" };
    }

    let run;
    try {
        const runResult = await campaignRunsRepository.getOrCreateCampaignRun({
            workspaceId: campaign.workspaceId,
            campaignId: campaign._id,
            scheduledFor,
        });
        run = runResult.run;
        if (!run) throw new Error("Campaign run could not be created");

        if (run.status === "completed") {
            const advance = buildScheduleAdvance(campaign.schedule, scheduledFor);
            await campaignsRepository.releaseScheduledCampaignLock({
                campaignId: campaign._id,
                workspaceId: campaign.workspaceId,
                lockedBy,
                update: {
                    $set: {
                        "schedule.lastRunAt": scheduledFor,
                        "schedule.nextRunAt": advance.nextRunAt,
                        "schedule.status": advance.status,
                        status: advance.nextRunAt ? CAMPAIGN_STATUSES.QUEUED : CAMPAIGN_STATUSES.COMPLETED,
                    },
                },
            });
            if (advance.nextRunAt) {
                await scheduleNextCampaignDispatch({
                    workspaceId: campaign.workspaceId,
                    campaignId: campaign._id,
                    runAt: advance.nextRunAt,
                });
            }
            return { ok: true, skipped: true, reason: "run_already_completed" };
        }

        const recipients = await resolveCampaignRecipients(campaign);
        if (!recipients.length) {
            const noRecipientsError = new Error("Scheduled campaign has no matching recipients");
            await campaignRunsRepository.markCampaignRunFailed({ runId: run._id, error: noRecipientsError });
            const advance = buildScheduleAdvance(campaign.schedule, scheduledFor);
            await campaignsRepository.releaseScheduledCampaignLock({
                campaignId: campaign._id,
                workspaceId: campaign.workspaceId,
                lockedBy,
                update: {
                    $set: {
                        "schedule.lastRunAt": scheduledFor,
                        "schedule.nextRunAt": advance.nextRunAt,
                        "schedule.status": advance.nextRunAt ? "active" : "failed",
                        status: advance.nextRunAt ? CAMPAIGN_STATUSES.QUEUED : CAMPAIGN_STATUSES.FAILED,
                        lastError: { message: noRecipientsError.message },
                    },
                },
            });
            if (advance.nextRunAt) {
                await scheduleNextCampaignDispatch({
                    workspaceId: campaign.workspaceId,
                    campaignId: campaign._id,
                    runAt: advance.nextRunAt,
                });
            }
            return { ok: false, failed: true, reason: "missing_recipients" };
        }

        await campaignRunsRepository.markCampaignRunRunning({ runId: run._id, total: recipients.length });
        await enqueueCampaignRecipients({
            workspaceId: campaign.workspaceId,
            campaignId: campaign._id,
            campaignRunId: run._id,
            templateId: campaign.templateId,
            recipients,
            delayMs: 1000,
        });

        const advance = buildScheduleAdvance(campaign.schedule, scheduledFor);
        await campaignsRepository.releaseScheduledCampaignLock({
            campaignId: campaign._id,
            workspaceId: campaign.workspaceId,
            lockedBy,
            update: {
                $set: {
                    status: CAMPAIGN_STATUSES.RUNNING,
                    scheduledAt: scheduledFor,
                    "schedule.lastRunAt": scheduledFor,
                    "schedule.nextRunAt": advance.nextRunAt,
                    "schedule.status": advance.status,
                },
                $inc: {
                    "schedule.occurrencesRun": 1,
                    "totals.total": recipients.length,
                    "totals.queued": recipients.length,
                },
                $unset: { lastError: 1 },
            },
        });

        emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, {
            workspaceId: campaign.workspaceId,
            campaignId: String(campaign._id),
            campaignRunId: String(run._id),
        });
        if (advance.nextRunAt) {
            await scheduleNextCampaignDispatch({
                workspaceId: campaign.workspaceId,
                campaignId: campaign._id,
                runAt: advance.nextRunAt,
            });
        }
        logger.info("Campaign schedule dispatched", {
            campaignId: String(campaign._id),
            campaignRunId: String(run._id),
            recipients: recipients.length,
        });
        return {
            ok: true,
            campaignId: String(campaign._id),
            campaignRunId: String(run._id),
            queued: recipients.length,
            nextRunAt: advance.nextRunAt ? advance.nextRunAt.toISOString() : null,
        };
    } catch (err) {
        await releaseFailedDispatch({ campaign, lockedBy, run, err });
        logger.warn("Campaign schedule run failed", {
            campaignId: String(campaign._id),
            campaignRunId: run?._id ? String(run._id) : null,
            message: err?.message || String(err),
        });
        throw err;
    }
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

async function reconcileDueCampaignSchedules({ limit } = {}) {
    const max = Math.min(Math.max(Number(limit || process.env.CAMPAIGN_SCHEDULE_RECONCILE_LIMIT || 500), 1), 5000);
    const campaigns = await campaignsRepository.listDueScheduledCampaigns({ now: new Date(), limit: max });
    if (campaigns.length) {
        logger.info("Campaign schedule reconciler found due schedules", { count: campaigns.length });
    }
    const results = await Promise.allSettled(
        campaigns.map(async (campaign) => {
            await scheduleNextCampaignDispatch({
                workspaceId: String(campaign.workspaceId),
                campaignId: campaign._id,
                runAt: campaign.schedule?.nextRunAt,
            });
            logger.info("Campaign schedule reconciler dispatched due schedule", {
                campaignId: String(campaign._id),
            });
        })
    );
    return {
        due: campaigns.length,
        dispatched: results.filter((result) => result.status === "fulfilled").length,
        failed: results.filter((result) => result.status === "rejected").length,
    };
}

module.exports = {
    scheduleNextCampaignDispatch,
    dispatchScheduledCampaign,
    recoverScheduledCampaignDispatches,
    reconcileDueCampaignSchedules,
};
