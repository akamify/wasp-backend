const { campaignQueue } = require("@infra/queues/index");
const { CAMPAIGN_QUEUE_JOBS } = require("@modules/campaigns/constants/campaign.constants");

function buildRecipientJobId({ campaignRunId, contactId, to }) {
    if (!campaignRunId) return undefined;
    const recipientKey = contactId ? `contact:${String(contactId)}` : `phone:${String(to)}`;
    return `campaign-message:${String(campaignRunId)}:${recipientKey}`;
}

async function enqueueCampaignRecipients({ workspaceId, campaignId, campaignRunId, templateId, recipients, delayMs }) {
    const queue = campaignQueue.getCampaignQueue();
    await Promise.all(
        recipients.map((recipient) =>
            queue.add(
                CAMPAIGN_QUEUE_JOBS.SEND_MESSAGE,
                {
                    workspaceId,
                    campaignId: String(campaignId),
                    campaignRunId: campaignRunId ? String(campaignRunId) : undefined,
                    contactId: recipient.contactId ? String(recipient.contactId) : undefined,
                    templateId: String(templateId),
                    to: recipient.to,
                    variables: recipient.variables,
                    headerVariables: recipient.headerVariables,
                    otpCode: recipient.otpCode,
                    buttonValues: recipient.buttonValues,
                    buttonTtlMinutes: recipient.buttonTtlMinutes,
                    flowTokens: recipient.flowTokens,
                    flowActionData: recipient.flowActionData,
                },
                {
                    delay: delayMs || 0,
                    jobId: buildRecipientJobId({
                        campaignRunId,
                        contactId: recipient.contactId,
                        to: recipient.to,
                    }),
                }
            )
        )
    );
}

async function enqueueScheduledCampaignDispatch({ workspaceId, campaignId, runAt }) {
    if (!runAt) return null;
    const nextRunAt = new Date(runAt);
    if (Number.isNaN(nextRunAt.getTime())) return null;
    const queue = campaignQueue.getCampaignQueue();
    const delay = Math.max(nextRunAt.getTime() - Date.now(), 0);
    return queue.add(
        CAMPAIGN_QUEUE_JOBS.DISPATCH_SCHEDULED,
        {
            workspaceId,
            campaignId: String(campaignId),
            runAt: nextRunAt.toISOString(),
        },
        {
            delay,
            jobId: `campaign-dispatch:${String(campaignId)}:${nextRunAt.getTime()}`,
            removeOnComplete: true,
            removeOnFail: 5000,
        }
    );
}

async function hasCampaignWorkers() {
    const queue = campaignQueue.getCampaignQueue();
    const workers = await queue.getWorkers();
    return Array.isArray(workers) && workers.length > 0;
}

module.exports = { enqueueCampaignRecipients, enqueueScheduledCampaignDispatch, hasCampaignWorkers };
