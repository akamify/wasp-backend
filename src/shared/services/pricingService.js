const { Message } = require("@infra/database/Message");
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
  const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
  const normalizedPhones = Array.from(new Set((phones || []).map((phone) => String(phone || "")).filter(Boolean)));
  if (!normalizedPhones.length) return new Set();

  const [conversationRows, messageRows] = await Promise.all([
    Conversation.find({
      workspaceId,
      wabaId,
      phone: { $in: normalizedPhones },
      lastInboundAt: { $gte: since },
    })
      .select("phone")
      .lean(),
    Message.find({
      workspaceId,
      wabaId,
      phone: { $in: normalizedPhones },
      direction: "inbound",
      createdAt: { $gte: since },
    })
      .select("phone")
      .lean(),
  ]);

  return new Set([...conversationRows, ...messageRows].map((row) => String(row.phone || "")));
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

