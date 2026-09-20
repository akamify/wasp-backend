require("module-alias/register");
const { test } = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { fixture, ws, otherWs, gatewayId, userId } = require("./payments-fixture.cjs");
const { createNativePayments } = require("../services/nativePayments.service");
const { createPaymentsService } = require("../services/payments.service");
const { createPaymentRecovery } = require("../services/paymentRecovery.service");
const { createNativeWebhooks } = require("../services/nativePaymentWebhooks.service");
const { createNativeClient } = require("../services/metaNativePayments.service");
const { configurationName, assertConfiguration, orderDetails, lookupPayment, storedInteractive } = require("../domain/nativePayments");
const { encryptCommerceSecret } = require("../services/commerceSecrets.service");
async function nativeFixture(t) {
  const f = await fixture(t), permissions = [], sent = [];
  f.state.orders[0].environment = "live"; f.state.settings.liveCheckoutEnabled = true; f.state.settings.reservationMinutes = 30;
  Object.assign(f.state.gateways[0], { environment: "live", webhookStatus: "verified", identityVerified: true,
    merchantAccountId: "acc_MerchantA", nativeConfigurationName: "Store A", nativePaymentStatus: "active" });
  f.flags.live = true; f.flags.native = true;
  f.config.nativeAllowed = (workspace, waba, phone, gateway) => f.flags.native && String(workspace) === ws && waba === "123" && phone === "456" && String(gateway) === gatewayId;
  const creds = { wabaId: "123", phoneNumberId: "456", graphApiVersion: "v23.0", accessToken: "never-log-test-token" };
  const state = { response: null, configuration: { configuration_name: "Store A", status: "Active", provider_mid: "acc_MerchantA", provider_name: "RazorPay" }, failSend: false, denied: "" };
  const native = createNativePayments({ repo: f.repo, config: f.config, now: f.now,
    credentials: async () => creds, policy: async () => { if (!f.state.binding) throw new Error("window closed"); },
    authorize: async (_ws, _user, key) => { permissions.push(key); if (state.denied === key) throw new Error("permission denied"); },
    client: () => ({ configuration: async () => ({ data: [state.configuration] }), lookup: async (_name, reference) => state.response ||
      { payments: [{ reference_id: reference, amount: { offset: 100, value: f.state.orders[0].totalPaise }, currency: "INR", status: "pending" }] } }),
    send: async (input) => { sent.push(input); if (state.failSend) throw new Error("response lost"); return { message: { whatsappMessageId: "wamid.native" } }; },
  });
  const recovery = createPaymentRecovery({ repo: f.repo, provider: f.provider, gateways: f.gateways, config: f.config, native, now: f.now, authorize: async () => {} });
  const service = createPaymentsService({ repo: f.repo, gateways: f.gateways, config: f.config, native, now: f.now, authorize: async () => {}, reconcile: recovery.reconcile });
  const input = () => ({ ...f.input(), mode: "whatsapp_native" });
  const checkout = () => service.checkout(ws, f.state.orders[0]._id, userId, input());
  const pay = () => { const attempt = f.state.attempts[0]; const payment = { id: "pay_NativeA", order_id: "order_NativeA", amount: attempt.amountPaise,
    amount_refunded: 0, currency: "INR", captured: true, status: "captured", account_id: "acc_MerchantA" };
    f.state.providerPayments.push(payment);
    state.response = { payments: [{ reference_id: attempt.reference, status: "captured", amount: { value: attempt.amountPaise, offset: 100 }, currency: "INR",
      transactions: [{ type: "razorpay", status: "success", id: payment.order_id, pg_transaction_id: payment.id }] }] }; return payment; };
  return { ...f, native, recovery, service, input, checkout, pay, nativeState: state, creds, sent, permissions };
}
test("native configuration verifies the exact merchant, active state, revision and permission", async (t) => {
  const f = await nativeFixture(t), input = { revision: f.state.gateways[0].revision, configurationName: "Store A" };
  await assert.rejects(f.native.configure(otherWs, gatewayId, userId, input));
  f.nativeState.configuration.provider_mid = "acc_OtherMerchant";
  await assert.rejects(f.native.configure(ws, gatewayId, userId, input), /verified Razorpay merchant/);
  f.nativeState.configuration.provider_mid = "acc_MerchantA";
  f.nativeState.denied = "commerce.gateway.manage";
  await assert.rejects(f.native.configure(ws, gatewayId, userId, input), /permission/); f.nativeState.denied = "";
  const result = await f.native.configure(ws, gatewayId, userId, input);
  assert.equal(result.gateway.nativeConfigurationName, "Store A"); assert.equal(result.acceptedBinding, true);
  assert.equal(JSON.stringify(result).includes("webhookSecretEnc"), false);
  await assert.rejects(f.native.configure(ws, gatewayId, userId, input), /changed/);
});
test("native checkout pins merchant and channel, sends once, verifies capture transactionally and keeps hosted idempotency separate", async (t) => {
  const f = await nativeFixture(t), input = f.input(), a = await f.checkout();
  assert.equal(a.mode, "whatsapp_native"); assert.equal(a.status, "payable"); assert.equal(a.paymentUrl, "");
  assert.equal(f.calls.create, 0); assert.equal(f.sent.length, 1); assert.equal(f.state.attempts[0].nativeMerchantAccountId, "acc_MerchantA");
  assert.ok(f.permissions.includes("inbox.reply"));
  assert.equal((await f.service.checkout(ws, a.orderId, userId, input)).id, a.id); assert.equal(f.sent.length, 1);
  await assert.rejects(f.service.checkout(ws, a.orderId, userId, { ...input, mode: "razorpay_payment_link" }), /changed/);
  const parameters = JSON.parse(f.sent[0].commerceContent.interactive.action.parameters);
  assert.equal(parameters.type, "physical-goods"); assert.equal(parameters.payment_settings[0].payment_gateway.razorpay.receipt, a.reference);
  assert.equal(parameters.total_amount.value, parameters.order.subtotal.value + parameters.order.shipping.value + parameters.order.tax.value);
  f.pay(); await f.recovery.reconcile(ws, a.id); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.payments.length, 1); assert.equal(f.state.orders[0].status, "confirmed"); assert.equal(f.state.notifications.length, 1);
  assert.equal(f.state.reservations[0].status, "consumed"); assert.equal(f.state.attempts[0].providerLinkId, undefined);
  await f.outbox.run(); assert.equal(f.calls.lastMessage.commerceContent.interactive.type, "order_status");
});
test("native timeout recovers by immutable lookup without a duplicate POST or fallback link", async (t) => {
  const f = await nativeFixture(t); f.nativeState.failSend = true;
  const a = await f.checkout(); assert.equal(a.status, "unknown");
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.attempts[0].status, "payable");
  assert.equal(f.sent.length, 1); assert.equal(f.calls.create, 0);
  f.pay(); f.flags.native = false; f.flags.checkout = false;
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.orders[0].paymentStatus, "captured");
});
test("concurrent native checkout requests send and reserve stock once", async (t) => {
  const f = await nativeFixture(t), input = f.input(), id = f.state.orders[0]._id;
  const results = await Promise.all([f.service.checkout(ws, id, userId, input), f.service.checkout(ws, id, userId, input)]);
  assert.equal(results[0].id, results[1].id); assert.equal(f.sent.length, 1); assert.equal(f.state.attempts.length, 1);
  assert.equal(f.state.products[0].stockReserved, 3);
});
test("native configuration changes during preflight abort before stock writes", async (t) => {
  const second = await nativeFixture(t), payload = second.native.payload;
  second.native.payload = async (...args) => {
    const result = await payload(...args); second.update("gateways", second.state.gateways[0], { revision: 99 }); return result;
  };
  await assert.rejects(second.checkout(), /changed/); assert.equal(second.state.attempts.length, 0); assert.equal(second.state.products[0].stockReserved, 1);
});
test("native full refund before first capture preserves paid state and blocks fulfillment, then syncs the merchant refund", async (t) => {
  const f = await nativeFixture(t), a = await f.checkout(), payment = f.pay();
  f.state.providerPayments[0] = { ...payment, status: "refunded", amount_refunded: payment.amount };
  await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.orders[0].paymentStatus, "captured"); assert.equal(f.state.orders[0].attentionReason, "payment_refunded_review");
  f.state.providerRefunds.push({ id: "rfnd_Native", payment_id: payment.id, amount: payment.amount, currency: "INR", status: "processed" });
  await f.recovery.syncRefunds(ws, f.state.payments[0]._id);
  assert.equal(f.state.refunds.length, 1); assert.equal(f.state.payments[0].refundedPaise, payment.amount);
  await f.outbox.run(); assert.equal(f.state.notifications[0].status, "blocked"); assert.equal(f.calls.send, 0);
});
test("native gates reject test orders, missing acceptance, closed windows, permissions and gateway changes before reserving", async (t) => {
  const f = await nativeFixture(t);
  f.flags.native = false; await assert.rejects(f.checkout()); f.flags.native = true;
  f.state.orders[0].environment = "test"; await assert.rejects(f.checkout()); f.state.orders[0].environment = "live";
  f.nativeState.denied = "inbox.reply"; await assert.rejects(f.checkout(), /permission/); f.nativeState.denied = "";
  f.state.binding = false; await assert.rejects(f.checkout(), /window/); f.state.binding = true;
  f.state.settings.reservationMinutes = 5; await assert.rejects(f.checkout(), /six minutes/); f.state.settings.reservationMinutes = 30;
  f.nativeState.configuration.status = "Needs_Testing"; await assert.rejects(f.checkout());
  assert.equal(f.state.attempts.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.state.products[0].stockReserved, 1);
});
test("native lookup and Razorpay amounts, accounts, order and capture state must all agree", async (t) => {
  const f = await nativeFixture(t), a = await f.checkout(), payment = f.pay();
  for (const patch of [{ amount: 1 }, { currency: "USD" }, { order_id: "order_Foreign" }, { account_id: "acc_Foreign" }, { status: "authorized", captured: false }]) {
    f.state.providerPayments[0] = { ...payment, ...patch };
    await assert.rejects(f.recovery.reconcile(ws, a.id)); assert.equal(f.state.payments.length, 0);
  }
  f.state.providerPayments[0] = payment; f.nativeState.response.payments[0].amount.offset = 1;
  await assert.rejects(f.recovery.reconcile(ws, a.id)); assert.equal(f.state.orders[0].paymentStatus, "pending");
});
test("native expiry/cancellation never unlocks another checkout from pending status; late capture requires stock review", async (t) => {
  const f = await nativeFixture(t), a = await f.checkout();
  await f.service.cancel(ws, a.id); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.sent.length, 2); assert.equal(JSON.parse(f.sent[1].commerceContent.interactive.action.parameters).order.status, "canceled");
  assert.equal(f.sent[1].commerceContent.metadata.kind, "order_status");
  assert.equal(f.sent[1].commerceContent.metadata.orderId, String(a.orderId));
  assert.equal(f.state.attempts[0].active, true); assert.equal(f.state.attempts[0].status, "requires_attention");
  f.advance(31 * 60000); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.reservations[0].status, "released"); assert.equal(f.sent.length, 2);
  await assert.rejects(f.service.checkout(ws, a.orderId, userId, { ...f.input(), idempotencyKey: "replacement_native_01" }));
  f.pay(); await f.recovery.reconcile(ws, a.id);
  assert.equal(f.state.orders[0].attentionReason, "payment_after_stock_release"); assert.equal(f.state.products[0].stockOnHand, 10);
});
test("native recovery rejects a different WhatsApp channel and keeps the original configuration after edits", async (t) => {
  const f = await nativeFixture(t), a = await f.checkout(); f.pay();
  f.creds.phoneNumberId = "999"; await assert.rejects(f.recovery.reconcile(ws, a.id), /binding/);
  assert.equal(f.state.payments.length, 0); f.creds.phoneNumberId = "456";
  f.state.gateways[0].nativeConfigurationName = "Changed config";
  await f.recovery.reconcile(ws, a.id); assert.equal(f.state.attempts[0].nativeConfigurationName, "Store A");
});
test("native physical delivery validates beneficiary and stores no plaintext shipping address in inbox interactive payload", async (t) => {
  const f = await nativeFixture(t), order = f.state.orders[0];
  const address = { name: "Customer", line1: "Private street 10", city: "Delhi", state: "Delhi", country: "IN", postalCode: "110001" };
  order.fulfillmentMethod = "delivery"; order.addressEnc = encryptCommerceSecret(JSON.stringify(address), { workspaceId: ws, recordId: order._id, field: "addressEnc" });
  await f.checkout(); const interactive = f.sent[0].commerceContent.interactive;
  assert.equal(JSON.parse(interactive.action.parameters).beneficiaries[0].country, "India");
  assert.equal(JSON.stringify(storedInteractive(interactive)).includes("Private street"), false);
  assert.equal(JSON.parse(interactive.action.parameters).beneficiaries[0].address_line1, address.line1);
  assert.throws(() => orderDetails(f.state.attempts[0], order, "789", { ...address, line1: "a".repeat(101) }, f.now()), /shipping address/);
});
test("native payload boundaries and failed/duplicate transactions are never interpreted as capture", async (t) => {
  const f = await nativeFixture(t), a = await f.checkout();
  const row = { reference_id: a.reference, status: "pending", currency: "INR", amount: { value: a.amountPaise, offset: 100 },
    transactions: [{ type: "razorpay", status: "failed" }] };
  assert.equal(lookupPayment({ payments: [row] }, f.state.attempts[0]).status, "pending");
  assert.throws(() => lookupPayment({ payments: [row, row] }, f.state.attempts[0]));
  assert.throws(() => lookupPayment({ payments: [{ ...row, status: "captured" }] }, f.state.attempts[0]));
  assert.throws(() => orderDetails({ ...f.state.attempts[0], amountPaise: 50000001 }, f.state.orders[0], "789", null, f.now()));
  for (const name of ["../other", "..", "", "a".repeat(61), "bad\nname"]) assert.throws(() => configurationName(name));
  const large = { ...f.state.orders[0], items: Array.from({ length: 100 }, (_, i) => ({ sku: `${i}${"s".repeat(95)}`, name: "\u{1F642}".repeat(60), unitPricePaise: 100, quantity: 1 })), subtotalPaise: 10000, totalPaise: 10000 };
  assert.throws(() => orderDetails({ ...f.state.attempts[0], amountPaise: 10000 }, large, "789", null, f.now()), /size limit/);
  assert.throws(() => assertConfiguration({ data: [{ ...f.nativeState.configuration, status: "Needs Testing" }] }, "Store A", f.state.gateways[0]));
});
test("native Meta adapter encodes paths, bounds requests and hides upstream tokens/errors", async () => {
  const calls = [], creds = { accessToken: "private", graphApiVersion: "v23.0", wabaId: "123", phoneNumberId: "456" };
  const api = createNativeClient(creds, { client: { get: async (path, options) => { calls.push({ path, options }); return { data: { ok: true } }; } } });
  await api.configuration("Store A"); await api.lookup("Store A", "awc_test");
  assert.equal(calls[0].path, "/123/payment_configuration/Store%20A"); assert.equal(calls[1].path, "/456/payments/Store%20A/awc_test");
  assert.equal(calls[0].options.maxRedirects, 0); assert.ok(calls[0].options.signal);
  const failed = createNativeClient(creds, { client: { get: async () => { throw new Error("private secret token"); } } });
  await assert.rejects(failed.lookup("Store A", "ref"), (error) => !JSON.stringify(error).includes("private"));
});
test("signed native webhook only schedules lookup; duplicate, foreign channel and raw-body tampering cannot confirm payment", async () => {
  const calls = [], secret = "test-meta-secret", reference = "awc_" + "a".repeat(24);
  const body = { object: "whatsapp_business_account", entry: [{ id: "123", changes: [{ field: "messages", value: { messaging_product: "whatsapp",
    metadata: { phone_number_id: "456" }, statuses: [{ type: "payment", status: "captured", payment: { reference_id: reference } },
      { type: "payment", status: "captured", payment: { reference_id: reference } }] } }] }] };
  const rawBody = Buffer.from(JSON.stringify(body)), signature = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const service = createNativeWebhooks({ repo: { scheduleNative: async (...args) => calls.push(args) }, signingSecret: () => secret,
    config: { paymentsEnabled: () => true, assertPaymentsReady: async () => {} } });
  await service.receive({ body, rawBody, signature }); assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 3), [reference, "123", "456"]);
  await assert.rejects(service.receive({ body, rawBody: Buffer.from("{}"), signature }), /signature/);
  const failing = createNativeWebhooks({ repo: { scheduleNative: async () => { throw new Error("database down"); } }, signingSecret: () => secret,
    config: { paymentsEnabled: () => true, assertPaymentsReady: async () => {} } });
  await assert.rejects(failing.receive({ body, rawBody, signature }), /database down/);
});
