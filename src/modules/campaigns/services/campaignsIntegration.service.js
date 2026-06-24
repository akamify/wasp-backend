const { HttpError } = require("@shared/utils/httpError");
const { Workspace } = require("@infra/database/Workspace");
const { Message } = require("@infra/database/Message");
const { templatesRepository } = require("@modules/campaigns/repositories/index");
const { normalizeRecipients } = require("@modules/campaigns/utils/normalizeRecipients");
const { computeCampaignEstimate } = require("@modules/campaigns/utils/estimate");
const {
    ensureBalance,
    getOrCreateWallet,
} = require("@modules/wallet/services/wallet.core.service");
const { sendTemplateMessageForUser } = require("@shared/services/outboundMessageService");
const { enqueueCampaignRecipients, hasCampaignWorkers } = require("@modules/campaigns/services/campaignsQueue.service");
const { emitCampaignEvent, CAMPAIGN_EVENTS } = require("@modules/campaigns/events/campaign.events");
const { assertTemplateBelongsToCurrentWaba } = require("@shared/services/templateOwnershipService");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { upsertContactMetadataForUser } = require("@shared/services/contactService");
const { resolveActiveConnection } = require("@shared/services/whatsappConnectionService");
const { fetchTemplateStatus } = require("@shared/utils/whatsappSender");
const { validateBeforeSend } = require("@shared/utils/templateStructure");
const { contactAttributesRepository } = require("@modules/contacts/repositories");
const { normalizeAttributesMap } = require("@modules/contacts/utils/attributes.utils");

function isUpstashRequestLimitError(err) {
    const msg = String(err?.message || "").toLowerCase();
    return msg.includes("max requests limit exceeded");
}

function buildPublicRequestId() {
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `api_${stamp}_${rand}`;
}

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

function normalizeRemoteStatus(status) {
    const s = String(status || "").toLowerCase();
    if (s.includes("approve")) return "approved";
    if (s.includes("reject")) return "rejected";
    if (s.includes("pause")) return "paused";
    if (s.includes("disable")) return "disabled";
    if (s.includes("pending")) return "pending";
    return s || "pending";
}

function buildRecipientContactPatch(recipient) {
    const patch = { source: "outbound" };
    if (recipient.name) patch.name = recipient.name;
    if (recipient.email) patch.email = recipient.email;
    if (recipient.company) patch.company = recipient.company;
    if (Array.isArray(recipient.tags)) patch.tags = recipient.tags;
    if (recipient.attributes && typeof recipient.attributes === "object" && !Array.isArray(recipient.attributes)) {
        patch.attributes = recipient.attributes;
    }
    return patch;
}

async function upsertApiCampaignContacts({ workspaceId, scope, recipients }) {
    const definitions = await contactAttributesRepository.listDefinitions({ workspaceId, includeInactive: true });
    const warnings = new Set();
    const normalizedRecipients = recipients.map((recipient) => {
        if (!recipient.attributes || typeof recipient.attributes !== "object" || Array.isArray(recipient.attributes)) return recipient;
        const normalized = normalizeAttributesMap(recipient.attributes, definitions, { allowUnknown: true });
        normalized.warnings.forEach((warning) => warnings.add(warning));
        return { ...recipient, attributes: normalized.values };
    });
    const batchSize = Math.min(Math.max(Number(process.env.API_CAMPAIGN_CONTACT_UPSERT_BATCH_SIZE || 100), 10), 500);
    for (let index = 0; index < normalizedRecipients.length; index += batchSize) {
        const batch = normalizedRecipients.slice(index, index + batchSize);
        await Promise.all(batch.map((recipient) =>
            upsertContactMetadataForUser({
                userId: workspaceId,
                wabaId: scope.wabaId,
                phoneNumberId: scope.phoneNumberId || null,
                phone: recipient.to,
                patch: buildRecipientContactPatch(recipient),
                createIfMissing: true,
            })
        ));
    }
    return Array.from(warnings);
}

async function syncTemplateFromMetaBeforeSend({ workspaceId, template }) {
    const connection = await resolveActiveConnection(workspaceId);
    if (!connection) throw new HttpError(400, "Active WhatsApp connection not configured");

    let remote;
    try {
        remote = await fetchTemplateStatus({
            accessToken: connection.accessToken,
            wabaId: connection.wabaId,
            templateName: template.name,
            metaTemplateId: template.metaTemplateId,
            graphApiVersion: connection.graphApiVersion,
        });
    } catch (err) {
        throw new HttpError(400, "Failed to verify template with Meta before sending", {
            message: err.message,
            metaDebug: err.metaDebug || null,
        });
    }

    if (!remote) {
        throw new HttpError(
            409,
            "Template does not exist in active Meta WABA. Refresh templates or create this template again."
        );
    }

    const remoteStatus = normalizeRemoteStatus(remote.status);
    if (remoteStatus !== "approved") {
        throw new HttpError(400, `Template is ${remoteStatus || "not approved"} on Meta`);
    }

    const remoteLanguage = String(remote.language || "").trim();
    const localLanguage = String(template.languageCode || template.language || "").trim();
    if (remoteLanguage && localLanguage && remoteLanguage !== localLanguage) {
        throw new HttpError(
            409,
            `Template language mismatch. Local template is ${localLanguage}, Meta template is ${remoteLanguage}. Refresh templates.`
        );
    }

    if (Array.isArray(remote.components) && remote.components.length) {
        template.components = remote.components;
    }
    if (remote.category) template.category = String(remote.category).trim().toLowerCase();
    if (remote.language) {
        template.language = remote.language;
        template.languageCode = remote.language;
    }
    template.status = remoteStatus;
    template.metaTemplateId = remote.id || template.metaTemplateId;
    template.syncedAt = new Date();
    template.lastSyncedAt = new Date();
    if (typeof template.save === "function") {
        await template.save();
    }
    return template;
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
    const scope = await requireActiveWabaScope(workspaceId);
    if (String(req.auth?.workspaceId || "") !== scope.workspaceId || String(req.auth?.wabaId || "") !== scope.wabaId) {
        throw new HttpError(403, "This API key belongs to a previous WhatsApp account. Generate a new API key for the current account.");
    }

    const campaignName = String(req.body?.campaignName || "").trim();
    if (!campaignName) throw new HttpError(400, "campaignName is required");

    const apiCampaign = await require("@infra/database/Campaign").Campaign.findOne({
        workspaceId,
        wabaId: scope.wabaId,
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
        select: "_id status category name language languageCode components wabaId metaTemplateId syncedAt lastSyncedAt",
    });
    if (!template) throw new HttpError(404, "Template not found");
    if (template.status !== "approved") throw new HttpError(400, "Template must be approved");
    await assertTemplateBelongsToCurrentWaba({ template, workspaceId });
    const sendTemplate = await syncTemplateFromMetaBeforeSend({ workspaceId, template });
    recipients.forEach((recipient) => validateBeforeSend(sendTemplate, recipient));
    const warnings = await upsertApiCampaignContacts({ workspaceId, scope, recipients });

    const estimate = await computeCampaignEstimate({ workspaceId, template: sendTemplate, recipients });
    if (estimate.estimatedCredits > 0) {
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
    let inlineLastFailure = null;
    let inlineWalletBlocked = false;
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
                try {
                    await sendTemplateMessageForUser({
                        userId: workspaceId,
                        campaignId: String(apiCampaign._id),
                        template: sendTemplate,
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
                    const storedError = buildStoredSendError(err);
                    lastFailure = storedError;
                    inlineLastFailure = storedError;
                    if (!err?.templateFailurePersisted) try {
                        await Message.create({
                            workspaceId,
                            wabaId: scope.wabaId,
                            campaignId: String(apiCampaign._id),
                            templateId: template._id,
                            phone: recipient.to,
                            direction: "outbound",
                            status: "failed",
                            statusTimestamps: { failedAt: new Date() },
                            text: "",
                            payload: { to: recipient.to, template: { id: String(template._id) }, runtime: { variables: recipient.variables || [] } },
                            error: storedError,
                        });
                    } catch { }
                    await require("@infra/database/Campaign").Campaign.updateOne(
                        { _id: apiCampaign._id, workspaceId },
                        { $inc: { "totals.queued": -1, "totals.failed": 1 } }
                    );
                    if (Number(err?.statusCode || err?.status) === 402) {
                        inlineWalletBlocked = true;
                        await require("@infra/database/Campaign").Campaign.updateOne(
                            { _id: apiCampaign._id, workspaceId },
                            { $set: { status: "failed", lastError: { message: "Insufficient wallet balance. Add credits to send templates." } } }
                        );
                        break;
                    }
                }
            }
            inlineSentCount = sentCount;
            inlineFailedCount = failedCount;

            await require("@infra/database/Campaign").Campaign.updateOne(
                { _id: apiCampaign._id, workspaceId },
                {
                    $set: {
                        // API campaign must stay running until user explicitly completes/cancels.
                        status: inlineWalletBlocked ? "failed" : "running",
                        ...(lastFailure ? { lastError: { message: lastFailure?.providerMessage || lastFailure?.message || "Failed" } } : {}),
                    },
                }
            );
        }
    }

    const refreshed = await require("@infra/database/Campaign").Campaign.findOne({ _id: apiCampaign._id, workspaceId });
    emitCampaignEvent(inlineWalletBlocked ? CAMPAIGN_EVENTS.FAILED : CAMPAIGN_EVENTS.PROCESSING, { campaignId: String(apiCampaign._id), workspaceId });

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

    if (processedInline && inlineFailedCount > 0) {
        const failureMessage =
            inlineLastFailure?.providerMessage ||
            inlineLastFailure?.message ||
            "Campaign send failed";
        throw new HttpError(
            inlineWalletBlocked ? 402 : inlineSentCount > 0 ? 409 : 400,
            failureMessage,
            {
                requestId,
                campaign: {
                    id: String(refreshed?._id || apiCampaign._id),
                    name: String(refreshed?.name || apiCampaign.name || ""),
                    type: String(refreshed?.type || apiCampaign.type || "api"),
                    status: String(refreshed?.status || "running"),
                },
                request: requestTotals,
                billing,
                error: inlineLastFailure || null,
            }
        );
    }

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
            warnings,
        },
        warnings,
    };
}

module.exports = { sendApiCampaignByName };


