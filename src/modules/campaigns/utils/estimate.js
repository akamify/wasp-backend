const { Conversation } = require("@infra/database/Conversation");
const { CUSTOMER_SERVICE_WINDOW_MS } = require("@shared/services/pricingService");
const { messageCostForTemplateCategory, roundCurrency } = require("@modules/wallet/services/wallet.core.service");

async function computeCampaignEstimate({ workspaceId, template, recipients }) {
    const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
    const recipientPhones = recipients.map((r) => r.to);
    const openWindowRows = await Conversation.find({
        workspaceId,
        phone: { $in: recipientPhones },
        lastInboundAt: { $gte: since },
    })
        .select("phone")
        .lean();

    const openWindowSet = new Set(openWindowRows.map((row) => String(row.phone || "")));
    const billableCount = recipients.filter((r) => !openWindowSet.has(String(r.to))).length;
    const freeCount = recipients.length - billableCount;
    const estimatedCredits = roundCurrency(messageCostForTemplateCategory(template.category, billableCount));

    return {
        totalRecipients: recipients.length,
        billableRecipients: billableCount,
        freeRecipients: freeCount,
        estimatedCredits,
        openWindowSet,
    };
}

module.exports = { computeCampaignEstimate };


