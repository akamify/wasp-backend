const { HttpError } = require("@shared/utils/httpError");
const { Workspace } = require("@infra/database/Workspace");
const { Message } = require("@infra/database/Message");
const { templatesRepository } = require("@modules/campaigns/repositories/index");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const {
    ensureBalance,
    getOrCreateWallet,
    messageCostForTemplateCategory,
    walletChargesEnabled,
    debit,
    credit,
} = require("@modules/wallet/services/wallet.core.service");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { enqueueCampaignRecipients, hasCampaignWorkers } = require("@modules/campaigns/services/campaignsQueue.service");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");

function isUpstashRequestLimitError(err) {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("max requests limit exceeded");
}

function buildPublicRequestId() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `api_${stamp}_${rand}`;
}

async function resolveWorkspaceIdFromApiKeyUser(req) {
    const workspaceIdHeader = req.headers["x-workspace-id"];
    if (workspaceIdHeader) {
        return String(workspaceIdHeader);
    }

    const ws = await Workspace.findOne({ ownerId: req.user.id, isActive: true })
        .sort({ createdAt: 1 })
        .select("_id");
    if (!ws) throw new HttpError(404, "Workspace not found for API key owner");
    return String(ws._id);
}

async function sendApiCampaignByName(req) {
    const requestId = buildPublicRequestId();
    const workspaceId = await resolveWorkspaceIdFromApiKeyUser(req);

    const campaignName = String(req.body?.campaignName || "").trim();
    if (!campaignName) throw new HttpError(400, "campaignName is required");

    const apiCampaign = await require("@infra/database/Campaign").Campaign.findOne({
        workspaceId,
        type: "api",
        name: campaignName,
    }).select("_id name templateId type");

    if (!apiCampaign) {
        throw new HttpError(404, "API campaign not found. Create an API campaign with this name first.");
    }

    const recipients = normalizeRecipients(req.body?.recipients);
    if (!recipients.length) throw new HttpError(400, "At least one recipient required");

    const template = await templatesRepository.getTemplateById({
        id: apiCampaign.templateId,
        workspaceId,
        select: "_id status category name language components wabaId",
    });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId });

    const estimate = await computeCampaignEstimate({ workspaceId, template, recipients });
    if (walletChargesEnabled() && estimate.estimatedCredits > 0) {
        try {
            await ensureBalance(workspaceId, estimate.estimatedCredits);
        } catch (err) {
            if (err instanceof HttpError && err.statusCode === 402) {
                const wallet = await getOrCreateWallet(workspaceId);
                throw new HttpError(402, "Insufficient wallet balance for this campaign", {
                    balance: wallet.balance,
                    required: estimate.estimatedCredits,
                    billableRecipients: estimate.billableRecipients,
                    freeRecipients: estimate.freeRecipients,
                    totalRecipients: recipients.length,
                });
            }
            throw err;
        }
    }

    await require("@infra/database/Campaign").Campaign.updateOne(
        { _id: apiCampaign._id, workspaceId },
        {
            $set: { status: "running" },
            $inc: {
                "totals.total": recipients.length,
                "totals.queued": recipients.length,
            },
            $unset: { lastError: 1 },
        }
    );

    const delayMs = req.body?.scheduledAt ? Math.max(new Date(req.body.scheduledAt).getTime() - Date.now(), 0) : 0;

    let queuedToRedis = true;
    let processedInline = false;
    let inlineSentCount = 0;
    let inlineFailedCount = 0;
    try {
        await enqueueCampaignRecipients({
            workspaceId,
            campaignId: apiCampaign._id,
            templateId: template._id,
            recipients,
            delayMs,
        });
    } catch (queueErr) {
        queuedToRedis = false;
        const queueErrorMessage = isUpstashRequestLimitError(queueErr)
            ? "Redis request limit exceeded. Campaign kept running; please upgrade/reset Redis plan and retry queue processing."
            : (queueErr?.message || "Failed to enqueue campaign jobs");
        await require("@infra/database/Campaign").Campaign.updateOne(
            { _id: apiCampaign._id, workspaceId },
            { $set: { lastError: { message: queueErrorMessage } } }
        );
    }

    if (delayMs === 0) {
        let hasWorkers = false;
        try {
            hasWorkers = await hasCampaignWorkers();
        } catch {
            hasWorkers = false;
        }

        if (!queuedToRedis || !hasWorkers) {
            processedInline = true;
            let sentCount = 0;
            let failedCount = 0;
            let lastFailure = null;

            await require("@infra/database/Campaign").Campaign.updateOne(
                { _id: apiCampaign._id, workspaceId },
                { $set: { status: "running" } }
            );

            for (const recipient of recipients) {
                const chargeAmount = estimate.openWindowSet.has(String(recipient.to)) ? 0 : messageCostForTemplateCategory(template.category, 1);
                try {
                    if (chargeAmount > 0) {
                        await debit(workspaceId, chargeAmount, "Message send (campaign)", {
                            campaignId: String(apiCampaign._id),
                            templateId: String(template._id),
                            to: recipient.to,
                        });
                    }
                    await sendTemplateMessageForUser({
                        userId: workspaceId,
                        campaignId: String(apiCampaign._id),
                        template,
                        to: recipient.to,
                        variables: recipient.variables,
                        headerVariables: recipient.headerVariables,
                        otpCode: recipient.otpCode,
                        buttonValues: recipient.buttonValues,
                        buttonTtlMinutes: recipient.buttonTtlMinutes,
                        flowTokens: recipient.flowTokens,
                        flowActionData: recipient.flowActionData,
                    });
                    sentCount += 1;
                    await require("@infra/database/Campaign").Campaign.updateOne(
                        { _id: apiCampaign._id, workspaceId },
                        { $inc: { "totals.queued": -1, "totals.sent": 1 } }
                    );
                } catch (err) {
                    failedCount += 1;
                    lastFailure = err;
                    try {
                        await Message.create({
                            workspaceId,
                            campaignId: String(apiCampaign._id),
                            templateId: template._id,
                            phone: recipient.to,
                            direction: "outbound",
                            status: "failed",
                            statusTimestamps: { failedAt: new Date() },
                            text: "",
                            payload: { to: recipient.to, template: { id: String(template._id) }, runtime: { variables: recipient.variables || [] } },
                            error: err?.response?.data || err?.message || err,
                        });
                    } catch { }
                    if (err?.response && chargeAmount > 0) {
                        try {
                            await credit(workspaceId, chargeAmount, "Message refund (campaign failed)", "internal", "", {
                                campaignId: String(apiCampaign._id),
                                templateId: String(template._id),
                                to: recipient.to,
                            });
                        } catch { }
                    }
                    await require("@infra/database/Campaign").Campaign.updateOne(
                        { _id: apiCampaign._id, workspaceId },
                        { $inc: { "totals.queued": -1, "totals.failed": 1 } }
                    );
                }
            }
            inlineSentCount = sentCount;
            inlineFailedCount = failedCount;

            await require("@infra/database/Campaign").Campaign.updateOne(
                { _id: apiCampaign._id, workspaceId },
                {
                    $set: {
                        // API campaign must stay running until user explicitly completes/cancels.
                        status: "running",
                        ...(lastFailure ? { lastError: { message: lastFailure?.message || "Failed" } } : {}),
                    },
                }
            );
        }
    }

    const refreshed = await require("@infra/database/Campaign").Campaign.findOne({ _id: apiCampaign._id, workspaceId });
    emitCampaignEvent(CAMPAIGN_EVENTS.PROCESSING, { campaignId: String(apiCampaign._id), workspaceId });

    const requestTotals = processedInline
        ? {
            totalRecipients: recipients.length,
            queued: 0,
            sent: inlineSentCount,
            failed: inlineFailedCount,
        }
        : {
            totalRecipients: recipients.length,
            queued: recipients.length,
            sent: 0,
            failed: 0,
        };

    const billing = {
        billableRecipients: Number(estimate.billableRecipients || 0),
        freeRecipients: Number(estimate.freeRecipients || 0),
        estimatedCredits: Number(estimate.estimatedCredits || 0),
    };

    return {
        success: true,
        message: processedInline ? "Campaign send request processed successfully." : "Campaign send request accepted.",
        data: {
            requestId,
            campaign: {
                id: String(refreshed?._id || apiCampaign._id),
                name: String(refreshed?.name || apiCampaign.name || ""),
                type: String(refreshed?.type || apiCampaign.type || "api"),
                status: String(refreshed?.status || "running"),
            },
            request: requestTotals,
            billing,
        },
    };
}

module.exports = { sendApiCampaignByName };


