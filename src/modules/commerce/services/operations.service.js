const { HttpError } = require("@shared/utils/httpError");
const { assertFulfillment } = require("../domain/fulfillment");
const { orderDto } = require("../domain/orders");
const { encryptCommerceSecret, decryptCommerceSecret } = require("./commerceSecrets.service");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const repository = require("../repositories/operations.repository");
function createOperationsService({ repo = repository, now = () => new Date(), newId = () => new (require("mongoose").Types.ObjectId)(),
  authorize = (ws, user) => requireWorkspacePermission(ws, "commerce.messages.send", user) } = {}) {
  async function fulfill(ws, id, input, userId) {
    return repo.transaction(async (session) => {
      const order = await repo.order(ws, id, session);
      if (!order) throw new HttpError(404, "Order not found.");
      const action = assertFulfillment(order, input);
      if (order.manualDeliveryId && action !== "allocate") throw new HttpError(409, "Manage this order through its delivery workflow.");
      if (await repo.hasPaymentIssue(ws, id, session)) throw new HttpError(409, "Resolve the refund or extra payment before fulfillment.");
      if (action === "allocate") {
        const reservation = await repo.reservation(ws, order.paidAttemptId, session);
        if (!reservation || reservation.status !== "released") throw new HttpError(409, "Inventory allocation requires inspection.");
        for (const item of reservation.items) if (!await repo.allocateStock(ws, item, now(), session))
          throw new HttpError(409, "There is not enough available stock to fulfill this late payment.");
        if (!await repo.allocateReservation(reservation, now(), session)) throw new HttpError(409, "Inventory allocation changed.");
      }
      const result = await repo.transitionOrder(order, { status: input.status, attentionReason: "" }, session);
      if (!result) throw new HttpError(409, "Order changed. Refresh before updating fulfillment.");
      const attempt = order.paidAttemptId && await repo.attempt(ws, order.paidAttemptId, session);
      if (attempt?.mode === "whatsapp_native" && ["confirmed", "processing", "out_for_delivery", "completed"].includes(result.status)) {
        const notification = { _id: newId(), workspaceId: ws, orderId: order._id,
          key: `native-status:${order._id}:${result.revision}`, requestedBy: userId || attempt.requestedBy };
        notification.payloadEnc = encryptCommerceSecret(JSON.stringify({ amountPaise: order.totalPaise }),
          { workspaceId: ws, recordId: notification._id, field: "payloadEnc" });
        await repo.outbox(notification, session);
      }
      return orderDto(result, true);
    });
  }
  async function retryNotification(ws, id, userId) {
    const record = await repo.notification(ws, id);
    if (!record) throw new HttpError(404, "Notification not found.");
    if (record.status !== "blocked") throw new HttpError(409, "Only a notification blocked before dispatch can be retried. Inspect unknown deliveries in the inbox.");
    await authorize(ws, userId);
    const context = { workspaceId: ws, recordId: record._id, field: "payloadEnc" };
    const payload = JSON.parse(decryptCommerceSecret(record.payloadEnc, context));
    const saved = await repo.retryNotification(record, encryptCommerceSecret(JSON.stringify({ ...payload, authorizedBy: userId }), context));
    if (!saved) throw new HttpError(409, "Notification was already retried.");
    return { id: String(saved._id), status: saved.status };
  }
  return { fulfill, retryNotification };
}
module.exports = { createOperationsService, ...createOperationsService() };
