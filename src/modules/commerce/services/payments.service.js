const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { quoteFromProducts, assertEditable, eventDto } = require("../domain/orders");
const { same, requestHash, attemptDto, paymentDto, page } = require("../domain/payments");
const validators = require("../validators/payments.validators");
const repository = require("../repositories/payments.repository");
const gatewayService = require("./gateway.service");
const configService = require("./paymentsReadiness.service");
function createPaymentsService({ repo = repository, gateways = gatewayService, config = configService,
  native = require("./nativePayments.service"),
  now = () => new Date(), newId = () => new mongoose.Types.ObjectId(),
  authorize = (ws, user) => requireWorkspacePermission(ws, "commerce.payments.manage", user),
  reconcile = (...args) => require("./paymentRecovery.service").reconcile(...args) } = {}) {
  const conflict = () => new HttpError(409, "Checkout changed or needs a fresh merchant review.");
  async function owned(ws, id, session) {
    const order = await repo.order(ws, id, session);
    if (!order) throw new HttpError(404, "Commerce order not found.");
    return order;
  }
  async function checkout(ws, orderId, userId, input) {
    const data = validators.parse(validators.checkout, input), fingerprint = requestHash(orderId, data);
    const existing = await repo.byKey(ws, data.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== fingerprint || !same(existing.orderId, orderId)) throw conflict();
      return attemptDto(existing, now());
    }
    if (!config.checkoutEnabled()) throw new HttpError(503, "New Commerce checkout is disabled.");
    const original = await owned(ws, orderId);
    if (original.manualDeliveryId || (process.env.COMMERCE_DELIVERY_ENABLED === "true" && original.fulfillmentMethod === "delivery")) await require("../delivery/readiness").ready();
    // Resolve/refresh credentials before the transaction; it contains no network I/O.
    await gateways.getMerchantAuthentication(ws, data.gatewayConnectionId, original.environment);
    await authorize(ws, userId);
    const nativeSnapshot = data.mode === "whatsapp_native" ? await native.prepare(ws, original, data.gatewayConnectionId, userId) : null;
    if (nativeSnapshot) {
      const settings = await repo.settings(ws);
      if ((settings?.reservationMinutes || 30) < 6) throw new HttpError(409, "Native checkout needs a reservation of at least six minutes.");
      await native.payload(ws, { ...nativeSnapshot, reference: `awc_${"0".repeat(24)}`, environment: original.environment,
        amountPaise: original.totalPaise, expiresAt: new Date(now().getTime() + (settings.reservationMinutes || 30) * 60000) }, original);
    }
    let created;
    try {
      created = await repo.transaction(async (session) => {
        const duplicate = await repo.byKey(ws, data.idempotencyKey, session);
        if (duplicate) { if (duplicate.requestHash !== fingerprint) throw conflict(); return duplicate; }
        const order = await owned(ws, orderId, session); assertEditable(order);
        if (!config.checkoutEnabled() || order.revision !== data.revision || !order.reviewedAt || !order.reviewedBy
            || order.status !== "needs_review" || order.totalPaise < 100) throw conflict();
        const settings = await repo.settings(ws, session);
        if (!settings?.enabled || !await repo.workspaceActive(ws, session)) throw new HttpError(409, "Workspace Commerce is disabled.");
        if (!await repo.connectionMatches(ws, order.wabaId, order.phoneNumberId, session)
            || !await repo.catalog(ws, { _id: order.catalogConnectionId, wabaId: order.wabaId, phoneNumberId: order.phoneNumberId }, session))
          throw new HttpError(409, "Order channel or catalog was disconnected.");
        if ((order.fulfillmentMethod === "pickup" && !settings.pickupEnabled)
            || (order.fulfillmentMethod === "delivery" && (!settings.deliveryEnabled || !order.addressEnc))
            || !["pickup", "delivery"].includes(order.fulfillmentMethod)) throw conflict();
        const gateway = await repo.gateway(ws, data.gatewayConnectionId, session);
        if (nativeSnapshot && (gateway?.revision !== nativeSnapshot.gatewayRevision || !config.nativeAllowed(ws, order.wabaId, order.phoneNumberId, gateway._id)
            || settings.reservationMinutes < 6)) throw conflict();
        if (!gateway?.active || gateway.status !== "connected" || !gateway.credentialsVerifiedAt || gateway.environment !== order.environment
            || !gateway.webhookSecretEnc) throw new HttpError(409, "Configure the merchant gateway and payment webhook first.");
        if (order.environment === "live" && (!config.liveEnabled() || !settings.liveCheckoutEnabled
            || !require("../domain/liveGateway").liveGatewayReady(gateway, data.mode)))
          throw new HttpError(409, "Enable live checkout and configure the connected merchant gateway/webhook. Native payments additionally require verified account identity and webhook health.");
        const products = await repo.products(ws, order.catalogConnectionId, order.items.map((item) => item.sku), session);
        const delivery = process.env.COMMERCE_DELIVERY_ENABLED === "true" && order.fulfillmentMethod === "delivery"
          ? await require("../delivery/service").checkoutGuard(order, session) : null;
        if (order.fulfillmentMethod === "delivery" && products.some((p) => p.inventoryOutletId) && !delivery) throw new HttpError(409, "Branch inventory requires an accepted delivery order.");
        const fresh = quoteFromProducts(order.items, products, order.deliveryPaise, order.deliveryTaxRateBps, order.sourceItems);
        if (fresh.blockers.length || fresh.totalPaise !== order.totalPaise || fresh.items.some((item, i) =>
          !same(item.productId, order.items[i].productId) || item.productRevision !== order.items[i].productRevision
          || item.unitPricePaise !== order.items[i].unitPricePaise || item.quantity !== order.items[i].quantity)) throw conflict();
        const attemptId = newId(), expiresAt = new Date(now().getTime() + (settings.reservationMinutes || 30) * 60000);
        const attempt = await repo.createAttempt({ _id: attemptId, workspaceId: ws, orderId: order._id,
          gatewayConnectionId: gateway._id, orderRevision: order.revision, environment: order.environment, mode: data.mode,
          ...(nativeSnapshot ? Object.fromEntries(Object.entries(nativeSnapshot).filter(([key]) => key !== "gatewayRevision")) : {}),
          reference: `awc_${attemptId}`, idempotencyKey: data.idempotencyKey, requestHash: fingerprint,
          amountPaise: order.totalPaise, currency: "INR", expiresAt, nextCheckAt: now(), requestedBy: userId }, session);
        const tracked = [];
        for (const item of fresh.items) {
          const product = products.find((p) => same(p._id, item.productId));
          if (!await repo.reserveProduct(ws, product, item.quantity, now(), session, delivery?.outletId)) throw conflict();
          if (product.trackInventory) tracked.push({ productId: product._id, quantity: item.quantity, ...(delivery ? { outletId: delivery.outletId } : {}) });
        }
        await repo.createReservation({ workspaceId: ws, orderId: order._id, attemptId, items: tracked, expiresAt }, session);
        if (!await repo.fenceGateway(gateway, session) || !await repo.transitionOrder(order,
          { activeAttemptId: attemptId, status: "awaiting_payment", paymentStatus: "pending", attentionReason: "" }, session)) throw conflict();
        return attempt;
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const duplicate = await repo.byKey(ws, data.idempotencyKey);
      if (!duplicate || duplicate.requestHash !== fingerprint) throw conflict();
      return attemptDto(duplicate, now());
    }
    // The persisted attempt is the response even on provider failure. Retrying the
    // same key must never send another create request after an ambiguous outcome.
    await reconcile(ws, created._id).catch(() => {});
    return attemptDto(await repo.attempt(ws, created._id), now());
  }
  async function attempts(ws, orderId, input) {
    const query = validators.parse(validators.list, input, true), order = await owned(ws, orderId);
    if (order.environment !== query.environment) throw new HttpError(404, "Commerce order not found.");
    return page(await repo.attemptsForOrder(ws, orderId, query), query.limit, (a) => attemptDto(a, now()));
  }
  async function getAttempt(ws, id) {
    const record = await repo.attempt(ws, id);
    if (!record) throw new HttpError(404, "Checkout attempt not found.");
    return attemptDto(record, now());
  }
  async function cancel(ws, id) {
    await getAttempt(ws, id);
    await repo.requestCancel(ws, id, now());
    await reconcile(ws, id).catch(() => {});
    return getAttempt(ws, id);
  }
  async function reconcileOrder(ws, orderId) {
    const order = await owned(ws, orderId), id = order.activeAttemptId || order.paidAttemptId;
    if (!id) throw new HttpError(409, "Order has no checkout attempt to reconcile.");
    await reconcile(ws, id);
    return getAttempt(ws, id);
  }
  async function list(ws, input) {
    const query = validators.parse(validators.list, input, true);
    return page(await repo.listPayments(ws, query), query.limit, paymentDto);
  }
  async function refunds(ws, id, input) {
    const query = validators.parse(validators.list, input, true), payment = await repo.paymentById(ws, id);
    if (!payment || payment.environment !== query.environment) throw new HttpError(404, "Commerce payment not found.");
    return { payment: paymentDto(payment), ...page(await repo.listRefunds(ws, id, query), query.limit,
      (r) => ({ id: String(r._id), providerRefundId: r.providerRefundId, amountPaise: r.amountPaise, status: r.status, verifiedAt: r.verifiedAt })) };
  }
  async function settings(ws) {
    const record = await repo.settings(ws);
    return { revision: record?.revision || 0, liveCheckoutEnabled: record?.liveCheckoutEnabled || false,
      reservationMinutes: record?.reservationMinutes || 30, checkoutEnabled: config.checkoutEnabled(), liveEnabled: config.liveEnabled() };
  }
  async function changeSettings(ws, input) {
    const { revision, ...patch } = validators.parse(validators.settings, input);
    if (patch.liveCheckoutEnabled && !config.liveEnabled()) throw new HttpError(409, "Platform live checkout gate is disabled.");
    if (!await repo.saveSettings(ws, revision, patch)) throw conflict();
    return settings(ws);
  }
  async function listEvents(ws, input) {
    const query = validators.parse(validators.eventList, input, true);
    return page(await repo.listEvents(ws, query), query.limit, eventDto);
  }
  async function retryEvent(ws, id) {
    const event = await repo.retryEvent(ws, id, now());
    if (!event) throw new HttpError(409, "Only a dead-letter payment event can be retried.");
    return eventDto(event);
  }
  async function notifications(ws, orderId, input) {
    const query = validators.parse(validators.list, input, true), order = await owned(ws, orderId);
    if (order.environment !== query.environment) throw new HttpError(404, "Commerce order not found.");
    return page(await repo.listOutbox(ws, orderId, query), query.limit,
      (r) => ({ id: String(r._id), status: r.status, whatsappMessageId: r.whatsappMessageId, lastError: r.lastError, createdAt: r.createdAt }));
  }
  return { checkout, attempts, getAttempt, cancel, reconcileOrder, list, refunds, settings, changeSettings, listEvents, retryEvent, notifications };
}
module.exports = { createPaymentsService, ...createPaymentsService() };
