const { Message } = require("@infra/database/Message");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const {
  messageCostForTemplateCategoryLive,
  walletChargesEnabledLive,
} = require("@modules/wallet/services/wallet.core.service");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function isCustomerServiceWindowOpen({ workspaceId, phone }) {
  const scope = await requireActiveWabaScope(workspaceId);
  const since = new Date(Date.now() - CUSTOMER_SERVICE_WINDOW_MS);
  const lastInbound = await Message.findOne({
    workspaceId,
    wabaId: scope.wabaId,
    phone,
    direction: "inbound",
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .select({ _id: 1 })
    .lean();

  return !!lastInbound;
}

async function templateMessageChargeAmount({ workspaceId, phone, category }) {
  const forceCharge = await walletChargesEnabledLive();
  const customerServiceWindowOpen = forceCharge
    ? false
    : await isCustomerServiceWindowOpen({ workspaceId, phone });
  const amount = customerServiceWindowOpen
    ? 0
    : await messageCostForTemplateCategoryLive(category, 1);

  return {
    amount,
    walletChargesEnabled: forceCharge,
    customerServiceWindowOpen,
  };
}

module.exports = { isCustomerServiceWindowOpen, templateMessageChargeAmount, CUSTOMER_SERVICE_WINDOW_MS };

