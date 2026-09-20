const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { decryptCommerceSecret } = require("./commerceSecrets.service");
const { HttpError } = require("@shared/utils/httpError");
const repository = require("../repositories/payments.repository");
const configService = require("./paymentsReadiness.service");
const { orderStatus } = require("../domain/nativePayments");
const { hash } = require("../domain/gateway");
function createPaymentOutbox({ repo = repository, config = configService, now = () => new Date(),
  authorize = (ws, user, key = "commerce.messages.send") => requireWorkspacePermission(ws, key, user),
  send = (input) => require("@shared/services/outboundMessageService").sendTextMessageForUser(input) } = {}) {
  async function run() {
    if (!config.paymentsEnabled()) return { skipped: true };
    await config.assertPaymentsReady();
    await repo.expireOutbox(now());
    let sent = 0, deferred = 0;
    for (const row of await repo.pendingOutbox()) {
      const record = await repo.claimOutbox(row.workspaceId, row._id, now());
      if (!record) continue;
      let dispatchStarted = false;
      try {
        const order = await repo.order(record.workspaceId, record.orderId);
        if (!order || order.paymentStatus !== "captured" || !await repo.workspaceActive(record.workspaceId)
            || !await repo.connectionMatches(record.workspaceId, order.wabaId, order.phoneNumberId))
          throw new HttpError(409, "Order notification channel is unavailable.");
        const payload = JSON.parse(decryptCommerceSecret(record.payloadEnc,
          { workspaceId: record.workspaceId, recordId: record._id, field: "payloadEnc" }));
        await authorize(record.workspaceId, payload.authorizedBy || record.requestedBy);
        if (!Number.isSafeInteger(payload.amountPaise) || payload.amountPaise !== order.totalPaise) throw new HttpError(409, "Payment summary requires inspection.");
        const rupees = `${Math.floor(payload.amountPaise / 100)}.${String(payload.amountPaise % 100).padStart(2, "0")}`;
        const attempt = order.paidAttemptId && await repo.attempt(record.workspaceId, order.paidAttemptId);
        let commerceContent;
        if (attempt?.mode === "whatsapp_native") {
          await authorize(record.workspaceId, payload.authorizedBy || record.requestedBy, "inbox.reply");
          const status = ({ confirmed: "processing", processing: "processing", ready: "processing", out_for_delivery: "shipped", completed: "completed" })[order.status];
          if (!status || order.wabaId !== attempt.nativeWabaId || order.phoneNumberId !== attempt.nativePhoneNumberId)
            throw new HttpError(409, "Native fulfillment update requires merchant review.");
          commerceContent = { interactive: orderStatus(attempt.reference, status, `Order ${order.orderNumber}: ${status}. Payment of INR ${rupees} received.`),
            metadata: { kind: "order_status", orderId: String(order._id), orderNumber: order.orderNumber }, requestHash: hash(record.key) };
        }
        dispatchStarted = true;
        const result = await send({ userId: record.workspaceId, to: order.customerPhone,
          text: commerceContent?.interactive.body.text || `Payment of INR ${rupees} received for order ${order.orderNumber}. ${order.status === "requires_attention" ? "The merchant will review fulfillment and contact you." : "Your order is confirmed."}`,
          idempotencyKey: `commerce:${record.key}`, source: "api", senderType: "system", sentBy: { kind: "system" }, commerceContent,
          expectedCommerceBinding: { wabaId: order.wabaId, phoneNumberId: order.phoneNumberId } });
        const messageId = result?.message?.whatsappMessageId;
        if (!messageId || result.pendingDispatch) throw new HttpError(409, "Notification delivery is unknown.");
        await repo.finishOutbox(record, { status: "sent", whatsappMessageId: messageId, lastError: "" }); sent++;
      } catch (error) {
        const blocked = !dispatchStarted || error.commerceBeforeDispatch === true;
        await repo.finishOutbox(record, { status: blocked ? "blocked" : "unknown",
          lastError: blocked ? "notification_permission_channel_or_window_blocked" : "notification_delivery_unknown" }); deferred++;
      }
    }
    return { sent, deferred };
  }
  return { run };
}
module.exports = { createPaymentOutbox, ...createPaymentOutbox() };
