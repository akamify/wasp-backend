const { Message } = require("@infra/database/Message");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

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

module.exports = { isCustomerServiceWindowOpen, CUSTOMER_SERVICE_WINDOW_MS };

