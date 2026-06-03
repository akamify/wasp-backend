const { findOpenCustomerServiceWindowPhones } = require("@shared/services/pricingService");
const {
    messageCostForTemplateCategoryLive,
    roundCurrency,
    walletChargesEnabledLive,
} = require("@modules/wallet/services/wallet.core.service");

async function computeCampaignEstimate({ workspaceId, template, recipients }) {
    const recipientPhones = recipients.map((r) => r.to);
    const chargesEnabled = await walletChargesEnabledLive();
    const categoryCost = await messageCostForTemplateCategoryLive(template.category, 1);
    const openWindowSet = chargesEnabled
        ? new Set()
        : await findOpenCustomerServiceWindowPhones({
            workspaceId,
            wabaId: template.wabaId,
            phones: recipientPhones,
        });
    const billableCount = recipients.filter((recipient) => !openWindowSet.has(String(recipient.to))).length;
    const freeCount = recipients.length - billableCount;
    const estimatedCredits = roundCurrency(categoryCost * billableCount);

    return {
        totalRecipients: recipients.length,
        billableRecipients: billableCount,
        freeRecipients: freeCount,
        estimatedCredits,
        categoryCost,
        walletChargesEnabled: chargesEnabled,
        openWindowSet,
    };
}

module.exports = { computeCampaignEstimate };


