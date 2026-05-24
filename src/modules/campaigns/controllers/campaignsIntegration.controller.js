const campaignsIntegrationService = require("@modules/campaigns/services/campaignsIntegration.service");

async function sendApiCampaignByName(req, res) {
    try {
        const result = await campaignsIntegrationService.sendApiCampaignByName(req);
        res.status(201).json(result);
    } catch (err) {
        const statusCode = Number(err?.statusCode || 500);
        const details = err?.details && typeof err.details === "object" ? err.details : undefined;

        const errorCodeMap = {
            400: "INVALID_REQUEST",
            401: "UNAUTHORIZED",
            402: "INSUFFICIENT_BALANCE",
            403: "FORBIDDEN",
            404: "NOT_FOUND",
            409: "CONFLICT",
            429: "RATE_LIMITED",
            500: "INTERNAL_ERROR",
        };

        return res.status(statusCode).json({
            success: false,
            error: {
                code: errorCodeMap[statusCode] || "INTERNAL_ERROR",
                message: String(err?.message || "Campaign send failed"),
                ...(details ? { details } : {}),
            },
        });
    }
}

module.exports = { sendApiCampaignByName };
