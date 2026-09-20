require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fixture, ws, otherWs, gatewayId, userId } = require("./payments-fixture.cjs");
const { createPaymentOutbox } = require("../services/paymentOutbox.service");
const { decryptCommerceSecret } = require("../services/commerceSecrets.service");
const sign = (raw, secret = "merchant-webhook-secret") => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const payload = (f, extra = {}) => ({ entity: "event", account_id: "acc_Merchant1", created_at: Math.floor(f.now().getTime() / 1000),
  event: "payment_link.paid", payload: { payment_link: { entity: f.state.providerLinks[0] }, payment: { entity: f.state.providerPayments[0] } }, ...extra });
test("payment webhooks authenticate exact raw bytes, reject wrong account, persist encrypted once and process fetched capture", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay();
  const raw = Buffer.from(JSON.stringify(payload(f), null, 2));
  await assert.rejects(f.webhooks.receive(gatewayId, Buffer.from(raw.toString().replace(/\n/g, "")), sign(raw), "event1"), /signature/);
  await assert.rejects(f.webhooks.receive(gatewayId, {}, sign(raw), "event1"), /signature/);
  f.state.gateways[0] = { ...f.state.gateways[0], identityVerified: true, merchantAccountId: "acc_Other" };
  await assert.rejects(f.webhooks.receive(gatewayId, raw, sign(raw), "event1"), /account mismatch/);
  f.state.gateways[0] = { ...f.state.gateways[0], merchantAccountId: "acc_Merchant1" };
  await f.webhooks.receive(gatewayId, raw, sign(raw), "event1"); await f.webhooks.receive(gatewayId, raw, sign(raw), "event1");
  const events = f.state.events.filter((e) => e.kind === "razorpay"); assert.equal(events.length, 1);
  assert.equal(events[0].payloadEnc.includes("acc_Merchant1"), false); assert.equal(f.state.payments.length, 0);
  await f.webhooks.run(); assert.equal(f.state.payments.length, 1); assert.equal(f.state.gateways[0].webhookStatus, "verified");
  assert.equal((await f.service.getAttempt(ws, a.id)).status, "captured");
});
test("webhook acknowledgement fails when durable persistence fails", async (t) => {
  const f = await fixture(t); await f.checkout(); f.pay(); const raw = Buffer.from(JSON.stringify(payload(f)));
  f.repo.persistEvent = async () => { throw new Error("database failure"); };
  await assert.rejects(f.webhooks.receive(gatewayId, raw, sign(raw), "event1")); assert.equal(f.state.payments.length, 0);
});
test("secret rotation has bounded overlap, encrypts under correct fields and old deliveries cannot verify the new secret", async (t) => {
  const f = await fixture(t); await f.checkout(); f.pay();
  const result = await f.webhooks.configure(ws, gatewayId, { revision: f.state.gateways[0].revision });
  const g = f.state.gateways[0]; assert.equal(result.secret.length, 64); assert.equal(result.gateway.webhookSecretEnc, undefined);
  assert.equal(decryptCommerceSecret(g.previousWebhookSecretEnc, { workspaceId: ws, recordId: gatewayId, field: "previousWebhookSecretEnc" }), "merchant-webhook-secret");
  await assert.rejects(f.webhooks.configure(ws, gatewayId, { revision: g.revision }), /retry window/);
  const raw = Buffer.from(JSON.stringify(payload(f)));
  await f.webhooks.receive(gatewayId, raw, sign(raw), "old_event"); await f.webhooks.run();
  assert.equal(f.state.gateways[0].webhookStatus, "needs_setup");
  await f.webhooks.receive(gatewayId, raw, sign(raw, result.secret), "new_event"); await f.webhooks.run();
  assert.equal(f.state.gateways[0].webhookStatus, "verified");
  f.advance(73 * 3600000); await assert.rejects(f.webhooks.receive(gatewayId, raw, sign(raw), "expired_old"), /signature/);
});
test("five failed event attempts dead-letter safely without trusting signed captured payload", async (t) => {
  const f = await fixture(t); await f.checkout(); f.pay(); const raw = Buffer.from(JSON.stringify(payload(f)));
  await f.webhooks.receive(gatewayId, raw, sign(raw), "event1");
  f.provider.fetchPayment = async () => { throw new Error("provider token secret must not be logged"); };
  for (let i = 0; i < 5; i++) { await f.webhooks.run(); f.advance(33 * 60000); }
  const event = f.state.events.find((e) => e.kind === "razorpay");
  assert.equal(event.status, "dead_letter"); assert.equal(event.attempts, 5); assert.equal(event.lastError, "merchant_event_verification_pending");
  assert.equal(f.state.payments.length, 0);
});
test("refund event arriving before capture reconciles original checkout before syncing the refund", async (t) => {
  const f = await fixture(t); await f.checkout(); f.pay();
  const refund = { id: "rfnd_Early1", payment_id: "pay_Test1", currency: "INR", amount: 500, status: "processed" };
  f.state.providerRefunds.push(refund); f.state.providerPayments[0] = { ...f.state.providerPayments[0], amount_refunded: 500 };
  const raw = Buffer.from(JSON.stringify(payload(f, { event: "refund.processed", payload: { refund: { entity: refund } } })));
  await f.webhooks.receive(gatewayId, raw, sign(raw), "refund_early"); await f.webhooks.run();
  assert.equal(f.state.payments.length, 1); assert.equal(f.state.refunds.length, 1); assert.equal(f.state.payments[0].refundedPaise, 500);
});
test("manual account identity requires access to a provider resource under both keys and trusted OAuth history", async (t) => {
  const f = await fixture(t), proofId = "500000000000000000000002";
  f.state.gateways.push({ ...f.state.gateways[0], _id: proofId, authType: "oauth", active: false, status: "disconnected",
    identityVerified: true, merchantAccountId: "acc_Trusted1" });
  f.state.providerPayments.push({ id: "pay_Proof1", entity: "payment", amount: 100, currency: "INR" });
  const input = { revision: f.state.gateways[0].revision, oauthGatewayConnectionId: proofId, providerPaymentId: "pay_Proof1" };
  await assert.rejects(f.webhooks.verifyManualIdentity(otherWs, gatewayId, userId, input), /not found/);
  const fetch = f.provider.fetchPayment; f.provider.fetchPayment = async (auth, id) => auth.merchant === gatewayId ? undefined : fetch(auth, id);
  await assert.rejects(f.webhooks.verifyManualIdentity(ws, gatewayId, userId, input), /do not prove/);
  assert.equal(f.state.gateways[0].identityVerified, false);
  f.provider.fetchPayment = fetch;
  const verified = await f.webhooks.verifyManualIdentity(ws, gatewayId, userId, input);
  assert.equal(verified.identityVerified, true); assert.equal(verified.merchantAccountId, "acc_Trusted1"); assert.equal(verified.nativePaymentStatus, "unverified");
});
test("confirmation outbox uses merchant's original channel and amount, and sends once", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  await f.outbox.run(); await f.outbox.run();
  assert.equal(f.calls.send, 1); assert.equal(f.state.notifications[0].status, "sent");
  assert.equal(f.calls.lastMessage.expectedCommerceBinding.phoneNumberId, "456");
  assert.match(f.calls.lastMessage.text, /INR 24\.00/); assert.equal(f.state.orders[0].paymentStatus, "captured");
});
test("notification timeout becomes unknown and never changes payment or blindly resends", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  let calls = 0;
  const outbox = createPaymentOutbox({ repo: f.repo, config: f.config, now: f.now, authorize: async () => {}, send: async () => { calls++; throw new Error("timeout"); } });
  await outbox.run(); await outbox.run();
  assert.equal(calls, 1); assert.equal(f.state.notifications[0].status, "unknown"); assert.equal(f.state.orders[0].paymentStatus, "captured");
});
test("notification permission loss and replaced WABA block dispatch without affecting captured state", async (t) => {
  const f = await fixture(t), a = await f.checkout(); f.pay(); await f.recovery.reconcile(ws, a.id);
  f.state.binding = false; await f.outbox.run();
  assert.equal(f.calls.send, 0); assert.equal(f.state.notifications[0].status, "blocked"); assert.equal(f.state.orders[0].paymentStatus, "captured");
});
