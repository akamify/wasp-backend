require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const schemas = require("../validators/operations.validators");
const { createCommerceMessages } = require("../services/commerceMessages.service");
const { createMetaCommerceMessages } = require("../services/metaCommerceMessages.service");
const { Message } = require("@infra/database/Message");
const ws = "100000000000000000000001", pid = "400000000000000000000001", aid = "500000000000000000000001";
const input = { kind: "product", to: "919999999999", productIds: [pid], idempotencyKey: "message_intent_test_01" };
function fixture() {
  const now = new Date("2026-09-10T12:00:00Z"), calls = [], catalog = { _id: "catalog", catalogId: "123", wabaId: "456", phoneNumberId: "789", catalogVisible: true, cartEnabled: true };
  const product = { _id: pid, sku: "SKU", name: "Example", available: true, syncStatus: "synced", revision: 2, syncedRevision: 2, trackInventory: true, stockOnHand: 3, stockReserved: 1, pricePaise: 1234 };
  const attempt = { _id: aid, orderId: "order", active: true, status: "payable", paymentUrl: "https://rzp.io/i/example", expiresAt: new Date(now.getTime() + 10000) };
  const order = { _id: "order", catalogConnectionId: "catalog", orderNumber: "A-1", customerPhone: input.to, wabaId: "456", phoneNumberId: "789", activeAttemptId: aid, paymentStatus: "unpaid", totalPaise: 1234, deliveryPaise: 0, fulfillmentMethod: "pickup", items: [{ name: "Example", quantity: 1, grossPaise: 1234 }] };
  const deps = { now: () => now, credentials: async () => ({ ...catalog, graphApiVersion: "v25.0", accessToken: "secret" }),
    repo: { catalog: async (workspace) => workspace === ws ? catalog : null, catalogThumbnail: async () => product, productsById: async (_ws, _cat, ids) => ids.includes(pid) ? [product] : [], attempt: async () => attempt, order: async () => order },
    policy: async (data) => calls.push({ policy: data }), authorize: async (...args) => calls.push({ permission: args }),
    sendText: async (data) => { calls.push({ send: data }); return { message: { _id: "message", whatsappMessageId: "wamid.test", status: "sent" } }; } };
  return { deps, catalog, product, order, attempt, calls, service: createCommerceMessages(deps) };
}
test("Commerce message validation rejects arbitrary payloads, duplicate products, invalid phone and mismatched kind fields", () => {
  assert.equal(schemas.parse(schemas.message, input).kind, "product");
  for (const patch of [{ to: "+919999999999" }, { productIds: [pid, pid] }, { amount: 1 }, { interactive: {} }, { kind: "catalog" }, { kind: "payment_request", attemptId: aid }])
    assert.throws(() => schemas.parse(schemas.message, { ...input, ...patch }), /Invalid/);
  assert.doesNotThrow(() => schemas.parse(schemas.message, { kind: "catalog", to: input.to, idempotencyKey: input.idempotencyKey }));
});
test("single, list and catalog messages use server catalog/SKU values and the shared durable sender", async () => {
  for (const kind of ["product", "product_list", "catalog"]) {
    const f = fixture(); const result = await f.service.send(ws, "user", { ...input, kind });
    const sent = f.calls.find((c) => c.send).send; assert.equal(result.status, "sent"); assert.equal(sent.userId, ws);
    assert.equal(sent.idempotencyKey, `commerce-message:${input.idempotencyKey}`); assert.equal(sent.commerceContent.interactive.type, kind === "catalog" ? "catalog_message" : kind);
    const action = sent.commerceContent.interactive.action;
    if (kind === "product") assert.deepEqual(action, { catalog_id: "123", product_retailer_id: "SKU" });
    if (kind === "product_list") assert.deepEqual(action.sections[0].product_items, [{ product_retailer_id: "SKU" }]);
    if (kind === "catalog") assert.deepEqual(action, { name: "catalog_message", parameters: { thumbnail_product_retailer_id: "SKU" } });
    assert.equal(f.calls[0].policy.workspaceId, ws); assert.equal(sent.expectedCommerceBinding.phoneNumberId, "789");
  }
});
test("empty or unsynchronized catalog cannot send a catalog message", async () => {
  const f = fixture(); f.deps.repo.catalogThumbnail = async () => null;
  await assert.rejects(f.service.send(ws, "user", { ...input, kind: "catalog" }), /needs an available synchronized product/);
  assert.equal(f.calls.filter((c) => c.send).length, 0);
});
test("foreign catalog, stale product sync, unavailability, reserved stock and closed window cannot dispatch", async () => {
  const f = fixture(); await assert.rejects(f.service.send("foreign", "user", input), /Connect a catalog/);
  for (const patch of [{ syncStatus: "pending" }, { syncedRevision: 1 }, { available: false }, { stockOnHand: 1 }, { archivedAt: new Date() }]) {
    const f = fixture(); Object.assign(f.product, patch); await assert.rejects(f.service.send(ws, "user", input), /available and synchronized/); assert.equal(f.calls.length, 0);
  }
  f.deps.policy = async () => { throw new Error("window closed"); };
  await assert.rejects(createCommerceMessages(f.deps).send(ws, "user", input), /window closed/);
  assert.equal(f.calls.filter((c) => c.send).length, 0);
});
test("payment message enforces customer, catalog, phone, current attempt, expiry and payment-view permission", async () => {
  const request = { kind: "payment_request", to: input.to, attemptId: aid, idempotencyKey: input.idempotencyKey };
  const f = fixture(); await f.service.send(ws, "user", request);
  assert.equal(f.calls[0].permission[2], "commerce.payments.view");
  assert.match(f.calls.find((c) => c.send).send.text, /Total \(tax inclusive\): INR 12.34/);
  for (const patch of [{ customerPhone: "918888888888" }, { catalogConnectionId: "other" }, { phoneNumberId: "other" }, { activeAttemptId: "other" }, { paymentStatus: "captured" }]) {
    const f = fixture(); Object.assign(f.order, patch); await assert.rejects(f.service.send(ws, "user", request), /no usable/);
  }
  f.attempt.expiresAt = f.deps.now(); await assert.rejects(f.service.send(ws, "user", request), /no usable/);
});
test("Meta adapter pins Graph destination, timeouts and payload and sanitizes provider errors", async () => {
  let options; const client = createMetaCommerceMessages({ request: async (data) => { options = data; return { data: { messages: [{ id: "wamid.test" }] } }; } });
  await client.send({ accessToken: "secret", graphApiVersion: "v25.0", phoneNumberId: "123", to: input.to, interactive: { type: "catalog_message" } });
  assert.equal(options.url, "https://graph.facebook.com/v25.0/123/messages"); assert.equal(options.maxRedirects, 0); assert.equal(options.timeout, 20000); assert.equal(options.data.type, "interactive");
  const failed = createMetaCommerceMessages({ request: async () => { throw new Error("secret-token"); } });
  await assert.rejects(failed.send({ graphApiVersion: "v25.0", phoneNumberId: "123" }), (e) => e.statusCode === 502 && !e.message.includes("secret"));
  await assert.rejects(client.send({ graphApiVersion: "https://evil.test", phoneNumberId: "123" }), /unavailable/);
});
test("shared sender does not repeat sent or uncertain dispatch and rejects key reuse for another payload", async (t) => {
  let record = { _id: "message", status: "sent", whatsappMessageId: "wamid.test", payload: { commerce: { requestHash: "hash" } } };
  t.mock.method(Message, "findOne", async (query) => { assert.equal(query.workspaceId, ws); return record; });
  const { sendTextMessageForUser } = require("@shared/services/outboundMessageService");
  const args = { userId: ws, to: input.to, text: "Example", idempotencyKey: "same", commerceContent: { requestHash: "hash" } };
  assert.equal((await sendTextMessageForUser(args)).idempotent, true);
  record = { ...record, whatsappMessageId: null, status: "failed", providerDispatchStartedAt: new Date() };
  assert.equal((await sendTextMessageForUser(args)).pendingDispatch, true);
  await assert.rejects(sendTextMessageForUser({ ...args, commerceContent: { requestHash: "changed" } }), /Message request changed/);
});
