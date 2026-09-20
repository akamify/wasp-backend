const mongoose = require("mongoose");
const crypto = require("node:crypto");
const { HttpError } = require("@shared/utils/httpError");
const { verifyMetaSignature } = require("@core/middleware/webhookSignature");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { encryptCommerceSecret, decryptCommerceSecret } = require("./commerceSecrets.service");
const { normalizeCart, quoteFromProducts } = require("../domain/orders");
const readiness = require("./ordersReadiness.service");
const repository = require("../repositories/orders.repository");
function createOrderIntake({ repo = repository, enabled = readiness.ordersEnabled, ready = readiness.assertOrdersReady,
  signingSecret = () => getMetaAppConfig().metaAppSecret, now = () => new Date(), newId = () => new mongoose.Types.ObjectId() } = {}) {
  async function receiveOrders({ body, rawBody, signature }) {
    if (!enabled()) return { skipped: true };
    const extract = (payload) => (Array.isArray(payload?.entry) ? payload.entry : []).flatMap((entry) =>
      (Array.isArray(entry?.changes) ? entry.changes : []).filter((change) => change?.field === "messages")
        .map((change) => ({ wabaId: entry.id, value: change.value })));
    if (!extract(body).some(({ value }) => Array.isArray(value?.messages) && value.messages.some((message) => message?.type === "order"))) return { skipped: true };
    // Mandatory even when the surrounding legacy webhook permits development bypasses.
    if (!verifyMetaSignature({ rawBody, signature, secret: signingSecret() })) throw new HttpError(401, "Commerce requires a valid Meta webhook signature.");
    const authenticatedBody = JSON.parse(rawBody.toString("utf8"));
    const changes = extract(authenticatedBody);
    await ready();
    let persisted = 0;
    for (const { wabaId, value } of changes) {
      const messages = (Array.isArray(value?.messages) ? value.messages : []).filter((message) => message?.type === "order");
      if (!messages.length || authenticatedBody.object !== "whatsapp_business_account" || value?.messaging_product !== "whatsapp"
          || !/^\d{1,30}$/.test(wabaId || "") || !/^\d{1,30}$/.test(value?.metadata?.phone_number_id || "")) continue;
      const phoneNumberId = value.metadata.phone_number_id;
      const tenants = await repo.exactTenants(wabaId, phoneNumberId);
      if (tenants.length !== 1) continue; // No WABA-only or phone-only fallback for Commerce.
      const workspaceId = tenants[0].workspaceId;
      const settings = await repo.settings(workspaceId);
      if (!settings?.enabled || !await repo.workspaceActive(workspaceId)) continue;
      const catalog = await repo.catalog(workspaceId, { wabaId, phoneNumberId });
      for (const message of messages) {
        if (typeof message.id !== "string" || !message.id.length || message.id.length > 512) continue;
        const _id = newId();
        let status = "pending", lastError = "";
        try { normalizeCart(message); } catch (error) { status = "dead_letter"; lastError = error.commerceCode || "invalid_cart"; }
        const contact = (Array.isArray(value.contacts) ? value.contacts : []).find((item) => item?.wa_id === message.from);
        const payload = { wabaId, phoneNumberId, catalogConnectionId: catalog ? String(catalog._id) : null,
          environment: (settings.testRecipients || []).includes(message.from) ? "test" : "live", message,
          customerName: typeof contact?.profile?.name === "string" ? contact.profile.name.slice(0, 150) : "" };
        const payloadEnc = encryptCommerceSecret(JSON.stringify(payload), { workspaceId, recordId: _id, field: "payloadEnc" });
        await repo.persistEvent({ _id, workspaceId, kind: "whatsapp.order",
          eventKey: `whatsapp.order:${wabaId}:${message.id}`, payloadEnc, status, lastError, nextAttemptAt: now() });
        persisted++;
      }
    }
    if (persisted && process.env.COMMERCE_DELIVERY_ENABLED === "true") {
      // The durable events and periodic scanner recover if queue wake-up fails.
      await require("@infra/queues/index").webhookQueue.getWebhookQueue().add("commerce.orders.intake", {}, { removeOnComplete: 100, removeOnFail: 100 }).catch(() => {});
    }
    return { persisted };
  }
  async function processEvent(event) {
    const payload = JSON.parse(decryptCommerceSecret(event.payloadEnc, { workspaceId: event.workspaceId, recordId: event._id, field: "payloadEnc" }));
    const cart = normalizeCart(payload.message);
    await repo.transaction(async (session) => {
      // Creation and event completion commit together; crash/redelivery cannot duplicate an order.
      const existing = await repo.existingOrder(event.workspaceId, payload.wabaId, cart.inboundMessageId, session);
      if (!existing) {
        const settings = await repo.settings(event.workspaceId, session);
        if (!settings?.enabled || !await repo.workspaceActive(event.workspaceId, session)) throw new HttpError(409, "workspace_disabled");
        if (!await repo.connectionMatches(event.workspaceId, payload.wabaId, payload.phoneNumberId, session)) throw new HttpError(400, "whatsapp_binding_changed");
        const catalog = payload.catalogConnectionId && await repo.catalog(event.workspaceId, { _id: payload.catalogConnectionId,
          wabaId: payload.wabaId, phoneNumberId: payload.phoneNumberId, catalogId: cart.catalogId }, session);
        if (!catalog) throw new HttpError(400, "catalog_binding_unavailable");
        const products = await repo.products(event.workspaceId, catalog._id, cart.items.map((item) => item.sku), session);
        const quote = quoteFromProducts(cart.items, products, 0, null, cart.items);
        const _id = newId();
        const { blockers: _blockers, productRevisions: _revisions, ...totals } = quote;
        await repo.createOrder({ _id, workspaceId: event.workspaceId, catalogConnectionId: catalog._id,
          wabaId: payload.wabaId, phoneNumberId: payload.phoneNumberId, inboundMessageId: cart.inboundMessageId,
          orderNumber: `AWC-${String(_id).toUpperCase()}`, customerPhone: cart.customerPhone, customerName: payload.customerName,
          receivedAt: cart.receivedAt, sourceItems: cart.items, environment: payload.environment, status: "needs_review", ...totals,
          customerNoteEnc: cart.customerNote ? encryptCommerceSecret(cart.customerNote, { workspaceId: event.workspaceId, recordId: _id, field: "customerNoteEnc" }) : "" }, session);
      }
      if (!await repo.finishEvent(event, { status: "processed", processedAt: now(), lastError: "" }, session))
        throw new HttpError(409, "event_lease_lost");
    });
  }
  async function runOrderIntake() {
    if (!enabled()) return { skipped: true };
    await ready();
    const candidates = await repo.eventCandidates(now());
    let processed = 0, failed = 0;
    for (const candidate of candidates) {
      const event = await repo.claimEvent(candidate.workspaceId, candidate._id, crypto.randomUUID(), now());
      if (!event) continue;
      try { await processEvent(event); processed++; }
      catch (error) {
        const permanent = Boolean(error.commerceCode) || error.statusCode === 400;
        const code = error.commerceCode || (["workspace_disabled", "whatsapp_binding_changed", "catalog_binding_unavailable", "event_lease_lost"].includes(error.message) ? error.message : "order_processing_failed");
        await repo.finishEvent(event, { status: permanent || event.attempts >= 8 ? "dead_letter" : "pending", lastError: code,
          nextAttemptAt: new Date(now().getTime() + Math.min(3600000, 15000 * 2 ** Math.min(event.attempts, 8))) });
        failed++;
      }
    }
    return { processed, failed };
  }
  return { receiveOrders, runOrderIntake };
}
module.exports = { createOrderIntake, ...createOrderIntake() };
