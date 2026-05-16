const { campaignQueue } = require("@infra/queues/index");

async function enqueueCampaignRecipients({ workspaceId, campaignId, templateId, recipients, delayMs }) {
    const queue = campaignQueue.getCampaignQueue();
    await Promise.all(
        recipients.map((recipient) =>
            queue.add(
                "send-message",
                {
                    workspaceId,
                    campaignId: String(campaignId),
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
                }
            )
        )
    );
}

async function hasCampaignWorkers() {
    const queue = campaignQueue.getCampaignQueue();
    const workers = await queue.getWorkers();
    return Array.isArray(workers) && workers.length > 0;
}

module.exports = { enqueueCampaignRecipients, hasCampaignWorkers };
