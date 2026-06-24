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
    const openWindowSet = await findOpenCustomerServiceWindowPhones({
        workspaceId,
        wabaId: template.wabaId,
        phones: recipientPhones,
    });
    const billableCount = chargesEnabled ? recipients.length : 0;
    const freeCount = chargesEnabled ? 0 : recipients.length;
    const estimatedCredits = chargesEnabled ? roundCurrency(categoryCost * billableCount) : 0;

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


