const { Message } = require("@infra/database/Message");
const { CUSTOMER_SERVICE_WINDOW_MS } = require("@shared/services/pricingService");
const {
    messageCostForTemplateCategoryLive,
    roundCurrency,
    walletChargesEnabledLive,
} = require("@modules/wallet/services/wallet.core.service");

async function computeCampaignEstimate({ workspaceId, template, recipients }) {
    const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
    const recipientPhones = recipients.map((r) => r.to);
    const forceCharge = await walletChargesEnabledLive();
    const openWindowRows = forceCharge
        ? []
        : await Message.find({
            workspaceId,
            wabaId: template.wabaId,
            phone: { $in: recipientPhones },
            direction: "inbound",
            createdAt: { $gte: since },
        })
            .select("phone")
            .lean();

    const openWindowSet = new Set(openWindowRows.map((row) => String(row.phone || "")));
    const billableCount = recipients.filter((r) => !openWindowSet.has(String(r.to))).length;
    const freeCount = recipients.length - billableCount;
    const categoryCost = await messageCostForTemplateCategoryLive(template.category, 1);
    const estimatedCredits = roundCurrency(categoryCost * billableCount);

    return {
        totalRecipients: recipients.length,
        billableRecipients: billableCount,
        freeRecipients: freeCount,
        estimatedCredits,
        categoryCost,
        walletChargesEnabled: forceCharge,
        openWindowSet,
    };
}

module.exports = { computeCampaignEstimate };


