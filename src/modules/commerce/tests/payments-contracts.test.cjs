require("module-alias/register");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const { createRazorpayGateway } = require("../services/razorpayGateway.service");
const { linkPayload, assertLink, foundLink, paymentUrl, attemptDto } = require("../domain/payments");
const { assertCommerceMessageAllowed } = require("../services/commerceMessagePolicy.service");
const { Conversation } = require("@infra/database/Conversation");
const models = require("../models");
const repo = require("../repositories/payments.repository");
const readiness = require("../services/paymentsReadiness.service");
const { getIndexPlan } = require("../models/indexPlan");
const ws = "100000000000000000000001", id = "300000000000000000000001", now = new Date("2026-09-10T12:00:00Z");
const attempt = { _id: id, orderId: id, reference: `awc_${id}`, amountPaise: 2400, expiresAt: new Date(now.getTime() + 1800000), status: "payable", active: true, paymentUrl: "https://rzp.io/i/test" };
test("Payment Link contract explicitly disables partial payment and notifications, validates exact correlation and safe hosted URLs", () => {
  const data = linkPayload(attempt); assert.equal(data.currency, "INR"); assert.equal(data.accept_partial, false);
  assert.deepEqual(data.notify, { sms: false, email: false }); assert.equal(data.callback_url, undefined);
  const link = { ...data, id: "plink_Test1", status: "created", short_url: "https://rzp.io/i/test" };
  assert.equal(assertLink(link, attempt), link); assert.equal(foundLink(link, attempt), link);
  assert.equal(foundLink({ payment_links: [link] }, attempt), link); assert.equal(foundLink({ payment_links: [] }, attempt), null);
  assert.throws(() => foundLink({ items: [link] }, attempt)); assert.throws(() => foundLink({ payment_links: [link, link] }, attempt));
  for (const patch of [{ amount: 1 }, { currency: "USD" }, { accept_partial: true }, { reference_id: "other" }, { expire_by: 0 }])
    assert.throws(() => assertLink({ ...link, ...patch }, attempt));
  for (const short_url of ["http://rzp.io/i/test", "https://rzp.io.attacker.com/x", "https://user:secret@rzp.io/x", "https://rzp.io:444/x"])
    assert.throws(() => paymentUrl({ short_url }));
  assert.equal(attemptDto({ ...attempt, cancelRequestedAt: now }, now).paymentUrl, "");
  assert.equal(attemptDto(attempt, attempt.expiresAt).paymentUrl, "");
});
test("payment adapter pins merchant authentication, documented paths, request bounds and refund pagination", async () => {
  const calls = [], provider = createRazorpayGateway({ request: async (config) => { calls.push(config); return { data: {} }; } });
  const basic = { authType: "api_keys", keyId: "merchant-id", keySecret: "merchant-secret" }, bearer = { authType: "oauth", accessToken: "merchant-access" };
  await provider.createLink(basic, linkPayload(attempt)); await provider.fetchLink(bearer, "plink_Test1");
  await provider.findLink(basic, attempt.reference); await provider.findLinkForPayment(basic, "pay_Test1");
  await provider.cancelLink(basic, "plink_Test1"); await provider.fetchOrder(basic, "order_Test1");
  await provider.fetchRefund(basic, "rfnd_Test1"); await provider.fetchRefunds(basic, "pay_Test1", 25);
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/payment_links"); assert.equal(calls[0].auth.password, "merchant-secret");
  assert.equal(calls[1].headers.Authorization, "Bearer merchant-access"); assert.equal(calls[1].auth, undefined);
  assert.deepEqual(calls[2].params, { reference_id: attempt.reference }); assert.deepEqual(calls[3].params, { payment_id: "pay_Test1" });
  assert.equal(calls[4].method, "POST"); assert.match(calls[4].url, /plink_Test1\/cancel$/);
  assert.deepEqual(calls[7].params, { count: 25, skip: 25 });
  for (const call of calls) { assert.equal(call.maxRedirects, 0); assert.equal(call.timeout, 15000); assert.ok(call.signal); }
  assert.throws(() => provider.fetchLink(basic, "plink_../../wallet")); assert.throws(() => provider.fetchRefunds(basic, "pay_Test1", -1));
});
test("inventory query compares available quantity atomically, fences revision and uses the transaction", async (t) => {
  t.mock.method(models.CommerceProduct, "findOne", () => ({ select: () => ({ session: () => ({ lean: async () => ({ inventoryOutletId: null }) }) }) }));
  let query; const chain = { lean: async () => null };
  t.mock.method(models.CommerceProduct, "findOneAndUpdate", (filter, update, options) => { query = { filter, update, options }; return chain; });
  const session = { test: true };
  await repo.reserveProduct(ws, { _id: id, revision: 3, trackInventory: true }, 2, now, session);
  assert.equal(String(query.filter.$and[0].workspaceId), ws); assert.equal(query.filter.$and[1].revision, 3);
  assert.deepEqual(query.filter.$and[1].$expr, { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, 2] });
  assert.equal(query.update.$inc.stockReserved, 2); assert.equal(query.options.session, session); assert.equal(query.options.writeConcern, undefined);
  assert.equal(query.update.$set.syncNextAttemptAt, now);
  for (const key of Object.keys(query.update.$set)) assert.ok(models.CommerceProduct.schema.path(key), `Unknown product update field: ${key}`);
  await repo.resolveStock(ws, { productId: id, quantity: 2 }, true, now, session);
  assert.deepEqual(query.filter.$and[1].stockReserved, { $gte: 2 }); assert.equal(query.update.$inc.stockOnHand, -2);
  assert.equal(query.update.$set.syncNextAttemptAt, now);
  for (const key of Object.keys(query.update.$set)) assert.ok(models.CommerceProduct.schema.path(key));
});
test("attempt writes require workspace, lease owner and revision; cancellation preserves a racing worker's lease", async (t) => {
  let query;
  t.mock.method(models.CommerceCheckoutAttempt, "findOneAndUpdate", (filter, update, options) => { query = { filter, update, options };
    return { lean: async () => null, select: () => ({ lean: async () => null }) }; });
  await repo.updateAttempt({ _id: id, workspaceId: ws, revision: 8, leaseOwner: "worker1" }, { status: "captured" });
  assert.equal(String(query.filter.$and[0].workspaceId), ws); assert.equal(query.filter.$and[1].revision, 8); assert.equal(query.filter.$and[1].leaseOwner, "worker1");
  assert.equal(query.options.writeConcern.w, "majority"); assert.equal(query.options.writeConcern.j, true); assert.equal(query.update.$set.leaseOwner, "");
  await repo.requestCancel(ws, id, now); assert.equal(query.update.$set.paymentUrl, ""); assert.equal(query.update.$set.leaseOwner, undefined);
});
test("refund total uses monotonic max and durable event completion fences payment kind and worker", async (t) => {
  let paymentQuery, eventQuery;
  t.mock.method(models.CommercePayment, "findOneAndUpdate", (filter, update, options) => { paymentQuery = { filter, update, options }; return { lean: async () => null }; });
  t.mock.method(models.CommerceEvent, "findOneAndUpdate", (filter, update, options) => { eventQuery = { filter, update, options }; return { lean: async () => null }; });
  await repo.updatePayment({ _id: id, workspaceId: ws }, { refundedPaise: 500, lastError: "" });
  assert.deepEqual(paymentQuery.update.$max, { refundedPaise: 500 }); assert.equal(paymentQuery.update.$set.refundedPaise, undefined);
  await repo.finishEvent({ _id: id, workspaceId: ws, leaseOwner: "worker" }, { status: "processed" });
  assert.equal(eventQuery.filter.$and[1].kind, "razorpay"); assert.equal(eventQuery.filter.$and[1].leaseOwner, "worker");
});
test("commerce notification policy pins WABA and phone, denies missing/expired window including its exact boundary", async (t) => {
  let result = { customerServiceWindowExpiresAt: new Date(now.getTime() + 1) }, query;
  t.mock.method(Conversation, "findOne", (filter) => { query = filter;
    return { read: () => ({ select: () => ({ lean: async () => result }) }) }; });
  const input = { workspaceId: ws, to: "919999999999", credentials: { wabaId: "123", phoneNumberId: "456" }, expected: { wabaId: "123", phoneNumberId: "456" }, now };
  await assertCommerceMessageAllowed(input); assert.equal(query.$and[1].phone, input.to); assert.equal(query.$and[1].phoneNumberId, "456");
  result = { customerServiceWindowExpiresAt: now }; await assert.rejects(assertCommerceMessageAllowed(input), { commerceBeforeDispatch: true });
  result = null; await assert.rejects(assertCommerceMessageAllowed(input));
  await assert.rejects(assertCommerceMessageAllowed({ ...input, credentials: { ...input.credentials, wabaId: "other" } }));
});
test("native webhook scheduling requires original reference, WABA and phone without changing financial state", async (t) => {
  let query;
  t.mock.method(models.CommerceCheckoutAttempt, "updateOne", async (filter, update, options) => { query = { filter, update, options }; });
  await repo.scheduleNative("awc_reference", "123", "456", now);
  assert.deepEqual(query.filter, { reference: "awc_reference", mode: "whatsapp_native", nativeWabaId: "123", nativePhoneNumberId: "456" });
  assert.deepEqual(query.update, { $min: { nextCheckAt: now } }); assert.equal(query.options.writeConcern.w, "majority");
  for (const field of ["nativeConfigurationName", "nativeWabaId", "nativePhoneNumberId", "nativeMerchantAccountId"])
    assert.equal(models.CommerceCheckoutAttempt.schema.path(field).options.immutable, true);
});
test("native checkout requires every switch plus exact merchant-channel acceptance, while recovery stays enabled", (t) => {
  const keys = ["COMMERCE_PAYMENTS_ENABLED", "COMMERCE_CHECKOUT_ENABLED", "COMMERCE_LIVE_CHECKOUT_ENABLED", "COMMERCE_NATIVE_PAYMENTS_ENABLED", "COMMERCE_NATIVE_ACCEPTED_BINDINGS"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]));
  for (const key of keys.slice(0, 4)) process.env[key] = "true";
  process.env.COMMERCE_NATIVE_ACCEPTED_BINDINGS = `${ws}:123:456:${id}`;
  assert.equal(readiness.nativeAllowed(ws, "123", "456", id), true);
  assert.equal(readiness.nativeAllowed(ws, "123", "999", id), false);
  for (const key of keys.slice(0, 4)) { process.env[key] = "false"; assert.equal(readiness.nativeAllowed(ws, "123", "456", id), false); process.env[key] = "true"; }
  process.env.COMMERCE_NATIVE_PAYMENTS_ENABLED = "false"; assert.equal(readiness.paymentsEnabled(), true);
});
test("payment readiness checks feature, encryption, transaction topology and all indexes independently of new-checkout flag", async (t) => {
  const keys = ["COMMERCE_PAYMENTS_ENABLED", "COMMERCE_CHECKOUT_ENABLED", "CREDENTIALS_ENCRYPTION_KEY"], old = keys.map((k) => process.env[k]);
  const connection = mongoose.connection, oldDb = connection.db, descriptor = Object.getOwnPropertyDescriptor(connection, "readyState");
  t.after(() => { keys.forEach((k, i) => old[i] === undefined ? delete process.env[k] : process.env[k] = old[i]); connection.db = oldDb;
    if (descriptor) Object.defineProperty(connection, "readyState", descriptor); else delete connection.readyState; });
  process.env.COMMERCE_PAYMENTS_ENABLED = "false"; process.env.COMMERCE_CHECKOUT_ENABLED = "true";
  assert.equal(readiness.checkoutEnabled(), false); await assert.rejects(readiness.assertPaymentsReady());
  process.env.COMMERCE_PAYMENTS_ENABLED = "true"; process.env.CREDENTIALS_ENCRYPTION_KEY = "invalid"; await assert.rejects(readiness.assertPaymentsReady());
  process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); process.env.COMMERCE_CHECKOUT_ENABLED = "false";
  Object.defineProperty(connection, "readyState", { configurable: true, value: 1 });
  let topology = {}, missing = true; const plan = getIndexPlan(models);
  connection.db = { admin: () => ({ command: async () => topology }), collection: (name) => ({ listIndexes: () => ({ toArray: async () => missing ? []
    : plan.find((p) => p.collection === name).indexes.map((index) => ({ key: index.key, ...index.options })) }) }) };
  await assert.rejects(readiness.assertPaymentsReady()); topology = { setName: "test" }; await assert.rejects(readiness.assertPaymentsReady());
  missing = false; await readiness.assertPaymentsReady(); assert.equal(readiness.checkoutEnabled(), false);
});
