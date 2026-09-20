const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { decryptCommerceSecret } = require("./commerceSecrets.service");
const { assertCommerceMessageAllowed } = require("./commerceMessagePolicy.service");
const { createNativeClient } = require("./metaNativePayments.service");
const { configurationName, assertConfiguration, orderDetails, orderStatus, lookupPayment } = require("../domain/nativePayments");
const { hash, gatewayDto } = require("../domain/gateway");
const { same } = require("../domain/payments");
const repository = require("../repositories/payments.repository");
const readiness = require("./paymentsReadiness.service");
function createNativePayments({ repo = repository, config = readiness, credentials = getCredentialsForUser, client = createNativeClient,
  policy = assertCommerceMessageAllowed, now = () => new Date(),
  authorize = (ws, user, key) => requireWorkspacePermission(ws, key, user),
  send = (input) => require("@shared/services/outboundMessageService").sendTextMessageForUser(input) } = {}) {
  const conflict = (message = "Native checkout binding or eligibility changed. Verify the original merchant configuration.") => new HttpError(409, message);
  async function channel(ws, expected) {
    const creds = await credentials(ws);
    if (expected && (creds.wabaId !== expected.wabaId || creds.phoneNumberId !== expected.phoneNumberId)) throw conflict();
    return creds;
  }
  async function configure(ws, id, user, input) {
    await authorize(ws, user, "commerce.gateway.manage");
    const gateway = await repo.gateway(ws, id);
    if (!gateway || !gateway.active || gateway.status !== "connected" || gateway.environment !== "live"
        || gateway.revision !== input.revision || !gateway.credentialsVerifiedAt) throw conflict();
    const name = configurationName(input.configurationName), creds = await channel(ws);
    assertConfiguration(await client(creds).configuration(name), name, gateway);
    const saved = await repo.updateGateway(gateway, { nativeConfigurationName: name, nativePaymentStatus: "active" });
    if (!saved) throw conflict();
    return { gateway: gatewayDto(saved), acceptedBinding: Boolean(config.nativeAllowed(ws, creds.wabaId, creds.phoneNumberId, id)), checkedAt: now() };
  }
  async function prepare(ws, order, gatewayId, user) {
    const gateway = await repo.gateway(ws, gatewayId), creds = await channel(ws, order);
    if (!config.nativeAllowed(ws, order.wabaId, order.phoneNumberId, gatewayId) || order.environment !== "live"
        || !gateway?.active || gateway.status !== "connected" || gateway.environment !== "live" || !gateway.credentialsVerifiedAt
        || gateway.nativePaymentStatus !== "active" || gateway.webhookStatus !== "verified") throw conflict();
    for (const key of ["commerce.payments.manage", "commerce.messages.send", "inbox.reply"]) await authorize(ws, user, key);
    assertConfiguration(await client(creds).configuration(gateway.nativeConfigurationName), gateway.nativeConfigurationName, gateway);
    await policy({ workspaceId: ws, to: order.customerPhone, credentials: creds, expected: order, now: now() });
    return { nativeConfigurationName: gateway.nativeConfigurationName, nativeWabaId: order.wabaId, nativePhoneNumberId: order.phoneNumberId,
      nativeMerchantAccountId: gateway.merchantAccountId, gatewayRevision: gateway.revision };
  }
  async function payload(ws, attempt, order) {
    if (order.wabaId !== attempt.nativeWabaId || order.phoneNumberId !== attempt.nativePhoneNumberId) throw conflict();
    const catalog = await repo.catalog(ws, { _id: order.catalogConnectionId, wabaId: order.wabaId, phoneNumberId: order.phoneNumberId });
    if (!catalog) throw conflict();
    const address = order.addressEnc ? JSON.parse(decryptCommerceSecret(order.addressEnc,
      { workspaceId: ws, recordId: order._id, field: "addressEnc" })) : null;
    return orderDetails(attempt, order, catalog.catalogId, address, now());
  }
  async function dispatch(attempt) {
    const ws = attempt.workspaceId, order = await repo.order(ws, attempt.orderId);
    if (!order || !same(order.activeAttemptId, attempt._id) || order.paymentStatus === "captured") throw conflict();
    const latest = await repo.attempt(ws, attempt._id);
    if (latest?.cancelRequestedAt) throw conflict();
    const verified = await prepare(ws, order, attempt.gatewayConnectionId, attempt.requestedBy);
    for (const key of ["nativeConfigurationName", "nativeWabaId", "nativePhoneNumberId", "nativeMerchantAccountId"])
      if (verified[key] !== attempt[key]) throw conflict();
    const interactive = await payload(ws, attempt, order);
    return deliver(attempt, order, interactive, `native-checkout:${attempt.reference}`);
  }
  async function deliver(attempt, order, interactive, key) {
    const result = await send({ userId: attempt.workspaceId, to: order.customerPhone, text: interactive.body.text,
      source: "api", senderType: "business", sentBy: { kind: "api", actorId: attempt.requestedBy }, idempotencyKey: `commerce:${key}`,
      expectedCommerceBinding: { wabaId: attempt.nativeWabaId, phoneNumberId: attempt.nativePhoneNumberId },
      commerceContent: { interactive, metadata: { kind: interactive.type === "order_status" ? "order_status" : "payment_request", orderId: String(order._id), orderNumber: order.orderNumber,
        amountPaise: attempt.amountPaise, currency: "INR" }, requestHash: hash(key) } });
    if (!result.message?.whatsappMessageId || result.pendingDispatch) throw conflict("Native message delivery is unknown. The same checkout will be looked up without resending.");
    return result;
  }
  async function lookup(attempt) {
    const creds = await channel(attempt.workspaceId, { wabaId: attempt.nativeWabaId, phoneNumberId: attempt.nativePhoneNumberId });
    // Recovery keeps the immutable configuration even after it is renamed/disconnected in the UI.
    return lookupPayment(await client(creds).lookup(attempt.nativeConfigurationName, attempt.reference), attempt);
  }
  async function cancel(attempt) {
    const order = await repo.order(attempt.workspaceId, attempt.orderId);
    if (!order || order.paymentStatus === "captured") throw conflict();
    const creds = await channel(attempt.workspaceId, { wabaId: attempt.nativeWabaId, phoneNumberId: attempt.nativePhoneNumberId });
    for (const key of ["commerce.messages.send", "inbox.reply"]) await authorize(attempt.workspaceId, attempt.requestedBy, key);
    await policy({ workspaceId: attempt.workspaceId, to: order.customerPhone, credentials: creds, expected: order, now: now() });
    return deliver(attempt, order, orderStatus(attempt.reference, "canceled", `Cancellation requested for order ${order.orderNumber}.`), `native-cancel:${attempt.reference}`);
  }
  return { configure, prepare, payload, dispatch, lookup, cancel };
}
module.exports = { createNativePayments, ...createNativePayments() };
