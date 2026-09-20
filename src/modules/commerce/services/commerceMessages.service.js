const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { requireWorkspacePermission } = require("@modules/workspaces/services/workspacePermission.service");
const { assertCommerceMessageAllowed } = require("./commerceMessagePolicy.service");
const { hash } = require("../domain/gateway");
const { same, attemptDto } = require("../domain/payments");
const repository = require("../repositories/operations.repository");
const money = (paise) => `INR ${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
function createCommerceMessages({ repo = repository, credentials = getCredentialsForUser, now = () => new Date(),
  policy = assertCommerceMessageAllowed, authorize = (ws, user, key = "commerce.messages.send") => requireWorkspacePermission(ws, key, user),
  sendText = (input) => require("@shared/services/outboundMessageService").sendTextMessageForUser(input) } = {}) {
  async function send(ws, userId, input) {
    const creds = await credentials(ws);
    const catalog = await repo.catalog(ws, { wabaId: creds.wabaId, phoneNumberId: creds.phoneNumberId });
    if (!catalog) throw new HttpError(409, "Connect a catalog for this WhatsApp account.");
    let text, interactive, metadata;
    if (input.kind === "payment_request") {
      await authorize(ws, userId, "commerce.payments.view");
      const attempt = await repo.attempt(ws, input.attemptId), order = attempt && await repo.order(ws, attempt.orderId);
      const url = attempt && attemptDto(attempt, now()).paymentUrl;
      if (!order || order.customerPhone !== input.to || order.wabaId !== creds.wabaId || order.phoneNumberId !== creds.phoneNumberId
          || !same(order.catalogConnectionId, catalog._id)
          || !same(order.activeAttemptId, attempt._id) || order.paymentStatus === "captured" || !url)
        throw new HttpError(409, "This customer has no usable payment request on the current WhatsApp account.");
      text = `Order ${order.orderNumber}\n${order.items.map((item) => `${item.quantity} x ${Array.from(item.name).slice(0, 12).join("")}: ${money(item.grossPaise)}`).join("\n")}\nDelivery: ${money(order.deliveryPaise)}\nTotal (tax inclusive): ${money(order.totalPaise)}\nFulfillment: ${order.fulfillmentMethod}\nPay securely with the merchant's Razorpay link:\n${url}`;
      if (text.length > 4096) throw new HttpError(409, "This order summary exceeds the WhatsApp message limit.");
      metadata = { kind: input.kind, orderId: String(order._id), orderNumber: order.orderNumber, amountPaise: order.totalPaise, currency: "INR" };
    } else {
      if (!catalog.catalogVisible || !catalog.cartEnabled) throw new HttpError(409, "Enable catalog visibility and cart before sending products.");
      const products = input.kind === "catalog" ? [await repo.catalogThumbnail(ws, catalog._id)].filter(Boolean) : await repo.productsById(ws, catalog._id, input.productIds);
      if (!products.length) throw new HttpError(409, "The catalog needs an available synchronized product before it can be sent.");
      if (input.kind !== "catalog" && (products.length !== input.productIds.length || products.some((p) => p.archivedAt || !p.available
          || p.syncStatus !== "synced" || p.syncedRevision !== p.revision || (p.trackInventory && p.stockOnHand <= p.stockReserved))))
        throw new HttpError(409, "Selected products must be available and synchronized with Meta.");
      text = input.kind === "catalog" ? "Browse our catalog and add products to your cart." : products.map((p) => `${p.name} — ${money(p.pricePaise)}`).join("\n");
      const action = input.kind === "catalog" ? { name: "catalog_message", parameters: { thumbnail_product_retailer_id: products[0].sku } } : input.kind === "product"
        ? { catalog_id: catalog.catalogId, product_retailer_id: products[0].sku }
        : { catalog_id: catalog.catalogId, sections: [{ title: "Products", product_items: products.map((p) => ({ product_retailer_id: p.sku })) }] };
      interactive = { type: input.kind === "catalog" ? "catalog_message" : input.kind,
        body: { text: input.kind === "catalog" ? text : "Choose products from our catalog." }, action,
        ...(input.kind === "product_list" ? { header: { type: "text", text: "Our products" } } : {}) };
      metadata = { kind: input.kind, catalogId: catalog.catalogId, products: products.map((p) => ({ sku: p.sku, name: p.name, pricePaise: p.pricePaise })) };
    }
    await policy({ workspaceId: ws, to: input.to, credentials: creds, expected: catalog, now: now() });
    await authorize(ws, userId);
    const result = await sendText({ userId: ws, to: input.to, text, source: "api", senderType: "business", sentBy: { kind: "api", actorId: userId },
      idempotencyKey: `commerce-message:${input.idempotencyKey}`, expectedCommerceBinding: { wabaId: creds.wabaId, phoneNumberId: creds.phoneNumberId },
      commerceContent: { interactive, metadata, requestHash: hash(JSON.stringify([input.kind, input.to, input.productIds || [], input.attemptId || ""])) } });
    return { id: String(result.message?._id || ""), whatsappMessageId: result.message?.whatsappMessageId || null,
      status: result.pendingDispatch ? "unknown" : result.message?.status || "unknown" };
  }
  return { send };
}
module.exports = { money, createCommerceMessages, ...createCommerceMessages() };
