const { Conversation } = require("@infra/database/Conversation");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const {
  messageCostForTemplateCategoryLive,
  walletChargesEnabledLive,
} = require("@modules/wallet/services/wallet.core.service");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function isCustomerServiceWindowOpen({ workspaceId, phone }) {
  const scope = await requireActiveWabaScope(workspaceId);
  const openPhones = await findOpenCustomerServiceWindowPhones({
    workspaceId,
    wabaId: scope.wabaId,
    phones: [phone],
  });

  return openPhones.has(String(phone || ""));
}

async function findOpenCustomerServiceWindowPhones({ workspaceId, wabaId, phones }) {
  const now = new Date();
  const normalizedPhones = Array.from(new Set((phones || []).map((phone) => String(phone || "")).filter(Boolean)));
  if (!normalizedPhones.length) return new Set();

  const conversationRows = await Conversation.find({
    workspaceId,
    wabaId,
    phone: { $in: normalizedPhones },
    customerServiceWindowExpiresAt: { $gt: now },
  })
    .select("phone")
    .lean();

  return new Set(conversationRows.map((row) => String(row.phone || "")));
}

async function templateMessageChargeAmount({ workspaceId, phone, category }) {
  const chargesEnabled = await walletChargesEnabledLive();
  if (chargesEnabled) {
    return {
      amount: await messageCostForTemplateCategoryLive(category, 1),
      walletChargesEnabled: true,
      customerServiceWindowOpen: false,
    };
  }

  const customerServiceWindowOpen = await isCustomerServiceWindowOpen({ workspaceId, phone });
  return {
    amount: customerServiceWindowOpen ? 0 : await messageCostForTemplateCategoryLive(category, 1),
    walletChargesEnabled: false,
    customerServiceWindowOpen,
  };
}

module.exports = {
  isCustomerServiceWindowOpen,
  findOpenCustomerServiceWindowPhones,
  templateMessageChargeAmount,
  CUSTOMER_SERVICE_WINDOW_MS,
};

