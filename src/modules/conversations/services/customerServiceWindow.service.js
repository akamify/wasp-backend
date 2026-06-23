const { normalizePhone } = require("@shared/services/contactService");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const {
  reconcileServiceWindow,
  findConversationWindow,
} = require("../repositories/conversation.repository");

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function windowState(conversation, now = new Date()) {
  const expiresAt = conversation?.customerServiceWindowExpiresAt
    ? new Date(conversation.customerServiceWindowExpiresAt)
    : null;
  const expiresAtMs = expiresAt?.getTime();
  const isOpen = Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime();
  return {
    canReply: isOpen,
    serviceWindowStatus: isOpen ? "open" : "closed",
    customerServiceWindowExpiresAt: expiresAt || null,
    lastCustomerMessageAt: conversation?.lastCustomerMessageAt || null,
    remainingWindowMs: isOpen ? Math.max(0, expiresAtMs - now.getTime()) : 0,
  };
}

async function reconcileCustomerServiceWindow({ workspaceId, customerPhone, inboundAt, sourceMessageId }) {
  void sourceMessageId;
  const phone = normalizePhone(customerPhone);
  const occurredAt = new Date(inboundAt);
  if (!workspaceId || !phone || !Number.isFinite(occurredAt.getTime())) return null;

  const scope = await requireActiveWabaScope(workspaceId);
  const expiresAt = new Date(occurredAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
  return reconcileServiceWindow({
    workspaceId,
    wabaId: scope.wabaId,
    customerPhone: phone,
    inboundAt: occurredAt,
    expiresAt,
    updatedAt: new Date(),
  });
}

async function getCustomerServiceWindow({ workspaceId, customerPhone }) {
  const phone = normalizePhone(customerPhone);
  if (!phone) return windowState(null);
  const scope = await requireActiveWabaScope(workspaceId);
  const conversation = await findConversationWindow({ workspaceId, wabaId: scope.wabaId, customerPhone: phone });
  return windowState(conversation);
}

module.exports = {
  CUSTOMER_SERVICE_WINDOW_MS,
  reconcileCustomerServiceWindow,
  getCustomerServiceWindow,
  windowState,
};
