const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { parseRupees } = require("../domain/money");
const { assertEditable, quoteFromProducts, orderDto, eventDto } = require("../domain/orders");
const { encryptCommerceSecret, decryptCommerceSecret } = require("./commerceSecrets.service");
const { hash, randomToken } = require("../domain/gateway");
const validators = require("../validators/orders.validators");
const repository = require("../repositories/orders.repository");
const defaults = { enabled: false, pickupEnabled: true, deliveryEnabled: false, pickupInstructions: "", testRecipients: [], revision: 0 };
function settingsDto(record) { return Object.fromEntries(Object.keys(defaults).map((key) => [key, record?.[key] ?? defaults[key]])); }
function createOrdersService({ repo = repository, now = () => new Date(), newId = () => new mongoose.Types.ObjectId(), random = randomToken } = {}) {
  const conflict = () => new HttpError(409, "Order changed. Reload its quote before retrying.");
  const seal = (order, field, value) => encryptCommerceSecret(value, { workspaceId: order.workspaceId, recordId: order._id, field });
  const open = (order, field) => decryptCommerceSecret(order[field], { workspaceId: order.workspaceId, recordId: order._id, field });
  async function owned(workspaceId, id, session) {
    const record = await repo.order(workspaceId, id, session);
    if (!record) throw new HttpError(404, "Commerce order not found.");
    return record;
  }
  async function context(order, session) {
    const settings = await repo.settings(order.workspaceId, session);
    if (!settings?.enabled || !await repo.workspaceActive(order.workspaceId, session)) throw new HttpError(409, "Workspace Commerce is disabled.");
    if (!await repo.connectionMatches(order.workspaceId, order.wabaId, order.phoneNumberId, session)
        || !await repo.catalog(order.workspaceId, { _id: order.catalogConnectionId, wabaId: order.wabaId, phoneNumberId: order.phoneNumberId }, session))
      throw new HttpError(409, "Order belongs to a disconnected WhatsApp or catalog binding.");
    return settings;
  }
  function details(order) {
    return { ...orderDto(order, true), address: order.addressEnc ? JSON.parse(open(order, "addressEnc")) : null,
      customerNote: order.customerNoteEnc ? open(order, "customerNoteEnc") : "" };
  }
  function fulfillmentPatch(order, settings, input) {
    if ((input.fulfillmentMethod === "pickup" && !settings.pickupEnabled) || (input.fulfillmentMethod === "delivery" && !settings.deliveryEnabled))
      throw new HttpError(409, "This fulfillment method is not enabled.");
    const address = input.address && { ...input.address, ...(input.address.location ? { location: { ...input.address.location, confirmedAt: now() } } : {}) };
    if (process.env.COMMERCE_DELIVERY_ENABLED === "true" && input.fulfillmentMethod === "delivery" && !address?.location?.confirmed) throw new HttpError(400, "Confirm the delivery location.");
    return { fulfillmentMethod: input.fulfillmentMethod,
      recommendedOutletId: null, branchRoutingStatus: input.fulfillmentMethod === "delivery" && address?.location?.confirmedAt && !order.manualDeliveryId ? "pending" : "manual",
      branchRoutingNextAt: null, branchRoutingToken: "", branchRoutingAttempts: 0,
      addressEnc: input.fulfillmentMethod === "delivery" ? seal(order, "addressEnc", JSON.stringify(address)) : "",
      status: "needs_review", reviewedAt: null, reviewedBy: "" };
  }
  async function freshQuote(order, session, items = order.items, deliveryPaise = order.deliveryPaise, deliveryTaxRateBps = order.deliveryTaxRateBps) {
    const products = await repo.products(order.workspaceId, order.catalogConnectionId, items.map((item) => item.sku), session);
    return quoteFromProducts(items, products, deliveryPaise, deliveryTaxRateBps, order.sourceItems);
  }
  const quotePatch = ({ blockers: _blockers, productRevisions: _revisions, currency: _currency, ...quote }) => quote;
  async function getSettings(workspaceId) { return settingsDto(await repo.settings(workspaceId)); }
  async function changeSettings(workspaceId, input) {
    const { revision, ...patch } = validators.parse(validators.settings, input);
    try {
      const record = await repo.saveSettings(workspaceId, revision, patch);
      if (!record) throw conflict();
      return settingsDto(record);
    } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
  }
  const page = (records, limit, dto) => ({ items: records.slice(0, limit).map((record) => dto(record)),
    nextCursor: records.length > limit ? String(records[limit - 1]._id) : null });
  async function list(workspaceId, query) { return page(await repo.listOrders(workspaceId, query), query.limit, orderDto); }
  async function get(workspaceId, id) { return details(await owned(workspaceId, id)); }
  async function quote(workspaceId, id) {
    return repo.transaction(async (session) => {
      const order = await owned(workspaceId, id, session); assertEditable(order); await context(order, session);
      return { orderRevision: order.revision, ...await freshQuote(order, session) };
    });
  }
  async function edit(workspaceId, id, input) {
    const data = validators.parse(validators.edit, input);
    return repo.transaction(async (session) => {
      const order = await owned(workspaceId, id, session); assertEditable(order);
      if (order.revision !== data.revision) throw conflict();
      const settings = await context(order, session);
      const items = data.items || order.items;
      if (items.some((item) => !order.sourceItems.some((source) => source.sku === item.sku))) throw new HttpError(400, "Only products from the original cart can be reviewed.");
      const deliveryPaise = parseRupees(data.deliveryPrice);
      if (data.fulfillmentMethod === "pickup" && (deliveryPaise !== 0 || data.deliveryTaxRateBps !== null))
        throw new HttpError(400, "Pickup requires zero delivery charge and no delivery tax rate.");
      const fresh = await freshQuote(order, session, items, deliveryPaise, data.deliveryTaxRateBps);
      const patch = fulfillmentPatch(order, settings, data);
      if (order.manualDeliveryId && data.fulfillmentMethod === "pickup") {
        await require("../delivery/service").rejectPending(order, session, "fulfillment_changed");
        patch.manualDeliveryId = null;
      }
      const saved = await repo.updateOrder(workspaceId, id, data.revision,
        { ...quotePatch(fresh), ...patch }, session);
      if (!saved) throw conflict();
      return details(saved);
    });
  }
  async function review(workspaceId, id, userId, input) {
    const data = validators.parse(validators.review, input);
    return repo.transaction(async (session) => {
      const order = await owned(workspaceId, id, session); assertEditable(order);
      if (order.revision !== data.revision) throw conflict();
      const settings = await context(order, session);
      if (!order.fulfillmentMethod || (order.fulfillmentMethod === "delivery" && !order.addressEnc)) throw new HttpError(409, "Confirm fulfillment details before review.");
      if ((order.fulfillmentMethod === "pickup" && !settings.pickupEnabled) || (order.fulfillmentMethod === "delivery" && !settings.deliveryEnabled))
        throw new HttpError(409, "Selected fulfillment method is disabled.");
      const fresh = await freshQuote(order, session);
      if (fresh.blockers.length) throw new HttpError(409, "Order has unavailable products, insufficient stock or unconfirmed tax.", { blockers: fresh.blockers });
      const expected = new Map(data.productRevisions.map((item) => [item.productId, item.revision]));
      if (fresh.totalPaise !== data.expectedTotalPaise || expected.size !== fresh.productRevisions.length
          || fresh.productRevisions.some((item) => expected.get(item.productId) !== item.revision)) throw conflict();
      const saved = await repo.updateOrder(workspaceId, id, data.revision,
        { ...quotePatch(fresh), status: "needs_review", reviewedAt: now(), reviewedBy: userId }, session);
      if (!saved) throw conflict();
      return details(saved);
    });
  }
  async function cancel(workspaceId, id, input) {
    const { revision } = validators.parse(validators.revisionBody, input);
    const order = await owned(workspaceId, id);
    if (order.revision !== revision) throw conflict();
    if (order.status === "cancelled") return details(order);
    assertEditable(order);
    if (order.manualDeliveryId) return repo.transaction(async (session) => {
      const current = await owned(workspaceId, id, session); assertEditable(current);
      if (current.revision !== revision) throw conflict();
      const delivery = require("../delivery/service");
      await delivery.rejectPending(current, session);
      const saved = await repo.updateOrder(workspaceId, id, revision, { status: "cancelled", reviewedAt: null, reviewedBy: "" }, session);
      if (!saved) throw conflict();
      return details(saved);
    });
    const saved = await repo.updateOrder(workspaceId, id, revision, { status: "cancelled", reviewedAt: null, reviewedBy: "" });
    if (!saved) throw conflict();
    return details(saved);
  }
  async function listEvents(workspaceId, query) { return page(await repo.listEvents(workspaceId, query), query.limit, eventDto); }
  async function retryEvent(workspaceId, id) {
    const event = await repo.retryEvent(workspaceId, id, now());
    if (!event) throw new HttpError(409, "Only a dead-letter order event can be retried.");
    return eventDto(event);
  }
  async function createFulfillmentSession(workspaceId, id, userId, input) {
    const { revision } = validators.parse(validators.revisionBody, input);
    const order = await owned(workspaceId, id); assertEditable(order); await context(order);
    if (order.revision !== revision) throw conflict();
    const token = random();
    const record = { _id: newId(), workspaceId, kind: "fulfillment", orderId: order._id, userId, environment: order.environment,
      tokenHash: hash(token), expiresAt: new Date(now().getTime() + 30 * 60000) };
    record.dataEnc = encryptCommerceSecret(JSON.stringify({ orderRevision: revision }), { workspaceId, recordId: record._id, field: "dataEnc" });
    await repo.createSession(record);
    return { token, expiresAt: record.expiresAt };
  }
  async function fulfillmentContext(token, session) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, "Invalid fulfillment session.");
    const record = await repo.findSession(hash(token), now(), session);
    if (!record) throw new HttpError(410, "Fulfillment session expired or already used.");
    const order = await owned(record.workspaceId, record.orderId, session); assertEditable(order);
    const binding = JSON.parse(decryptCommerceSecret(record.dataEnc, { workspaceId: record.workspaceId, recordId: record._id, field: "dataEnc" }));
    if (order.revision !== binding.orderRevision || order.environment !== record.environment) throw new HttpError(410, "Fulfillment session was superseded by an order change.");
    const settings = await context(order, session);
    return { record, order, settings };
  }
  async function getFulfillment(token) {
    const { record, order, settings } = await fulfillmentContext(token);
    // Bearer session does not disclose existing addresses, phone, items or private notes.
    return { locationRequired: process.env.COMMERCE_DELIVERY_ENABLED === "true", orderNumber: order.orderNumber, expiresAt: record.expiresAt, pickupEnabled: settings.pickupEnabled,
      deliveryEnabled: settings.deliveryEnabled, pickupInstructions: settings.pickupInstructions };
  }
  async function submitFulfillment(token, input) {
    const data = validators.parse(validators.fulfillment, input);
    return repo.transaction(async (session) => {
      const { record, order, settings } = await fulfillmentContext(token, session);
      const patch = fulfillmentPatch(order, settings, data);
      // Customer may select fulfillment but cannot authorize prices, payment or merchant review.
      if (data.fulfillmentMethod === "pickup") {
        if (order.manualDeliveryId) {
          await require("../delivery/service").rejectPending(order, session, "fulfillment_changed");
          patch.manualDeliveryId = null;
        }
        const fresh = await freshQuote(order, session, order.items, 0, null);
        Object.assign(patch, quotePatch(fresh));
      }
      if (!await repo.consumeSession(record, now(), session)) throw new HttpError(410, "Fulfillment session already used.");
      if (!await repo.updateOrder(order.workspaceId, order._id, order.revision, patch, session)) throw conflict();
      return { orderNumber: order.orderNumber, status: "needs_review" };
    });
  }
  return { getSettings, changeSettings, list, get, quote, edit, review, cancel, listEvents, retryEvent,
    createFulfillmentSession, getFulfillment, submitFulfillment };
}
module.exports = { createOrdersService, ...createOrdersService() };
