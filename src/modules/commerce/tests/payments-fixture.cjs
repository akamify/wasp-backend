const { fixture: orderFixture, ws, otherWs } = require("./orders-fixture.cjs");
const models = require("../models");
const { createPaymentsService } = require("../services/payments.service");
const { createPaymentRecovery } = require("../services/paymentRecovery.service");
const { createPaymentWebhooks } = require("../services/paymentWebhooks.service");
const { createPaymentOutbox } = require("../services/paymentOutbox.service");
const { encryptCommerceSecret } = require("../services/commerceSecrets.service");
const { same } = require("../domain/payments");
const gatewayId = "500000000000000000000001", userId = "200000000000000000000001";
async function fixture(t) {
  const f = orderFixture(t), { state, now } = f;
  let order = await f.create(); order = await f.editPickup(order);
  order = await f.service.review(ws, order.id, userId, f.reviewInput(order, await f.service.quote(ws, order.id)));
  state.orders[0] = { ...state.orders[0], environment: "test" };
  Object.assign(state, { attempts: [], reservations: [], payments: [], refunds: [], notifications: [], providerLinks: [], providerPayments: [], providerRefunds: [],
    gateways: [new models.CommerceGatewayConnection({ _id: gatewayId, workspaceId: ws, provider: "razorpay", environment: "test", authType: "api_keys",
      createdBy: userId, credentialsVerifiedAt: now(), webhookStatus: "needs_setup" }).toObject()] });
  state.gateways[0].webhookSecretEnc = encryptCommerceSecret("merchant-webhook-secret", { workspaceId: ws, recordId: gatewayId, field: "webhookSecretEnc" });
  const flags = { checkout: true, live: false, payments: true }, calls = { create: 0, cancel: 0, fetch: 0, send: 0, newAuth: [], readAuth: [] };
  const config = { checkoutEnabled: () => flags.checkout, liveEnabled: () => flags.live, paymentsEnabled: () => flags.payments, assertPaymentsReady: async () => {} };
  const find = (key, wsid, id) => state[key].find((r) => same(r.workspaceId, wsid) && same(r._id, id));
  const update = (key, record, patch) => { const i = state[key].findIndex((r) => same(r._id, record._id)); if (i < 0) return null;
    state[key][i] = { ...state[key][i], ...patch }; return state[key][i]; };
  const create = (key, model, fields) => { const doc = new models[model](fields); const error = doc.validateSync(); if (error) throw error;
    const row = doc.toObject(); state[key].push(row); return row; };
  let tail = Promise.resolve();
  const repo = { ...f.repo,
    transaction: (work) => { const result = tail.then(async () => {
      const snapshot = Object.fromEntries(Object.entries(state).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, [...v]]));
      try { return await work({ paymentTransaction: true }); } catch (error) { Object.assign(state, snapshot); throw error; }
    }); tail = result.catch(() => {}); return result; },
    gateway: async (wsid, id) => find("gateways", wsid, id), webhookGateway: async (id) => state.gateways.find((g) => same(g._id, id)),
    updateGateway: async (record, patch) => { const fresh = find("gateways", record.workspaceId, record._id);
      return fresh?.revision === record.revision ? update("gateways", fresh, { ...patch, revision: fresh.revision + 1 }) : null; },
    fenceGateway: async (record) => { const fresh = find("gateways", record.workspaceId, record._id);
      return fresh?.active && fresh.status === "connected" && fresh.revision === record.revision ? update("gateways", fresh, { revision: fresh.revision + 1 }) : null; },
    attempt: async (wsid, id) => find("attempts", wsid, id),
    byKey: async (wsid, key) => state.attempts.find((a) => same(a.workspaceId, wsid) && a.idempotencyKey === key),
    byReference: async (wsid, gid, reference) => state.attempts.find((a) => same(a.workspaceId, wsid) && same(a.gatewayConnectionId, gid) && a.reference === reference),
    byLink: async (wsid, gid, link) => state.attempts.find((a) => same(a.workspaceId, wsid) && same(a.gatewayConnectionId, gid) && a.providerLinkId === link),
    createAttempt: async (fields) => { if (state.attempts.some((a) => a.active && same(a.orderId, fields.orderId))) throw { code: 11000 };
      return create("attempts", "CommerceCheckoutAttempt", fields); },
    createReservation: async (fields) => create("reservations", "CommerceInventoryReservation", fields),
    transitionOrder: async (record, patch) => { const fresh = find("orders", record.workspaceId, record._id);
      return fresh?.revision === record.revision ? update("orders", fresh, { ...patch, revision: fresh.revision + 1 }) : null; },
    reserveProduct: async (wsid, product, quantity) => {
      const fresh = find("products", wsid, product._id);
      if (!fresh || fresh.revision !== product.revision || (fresh.trackInventory && fresh.stockOnHand - fresh.stockReserved < quantity)) return null;
      return update("products", fresh, { revision: fresh.revision + 1, stockReserved: fresh.stockReserved + (fresh.trackInventory ? quantity : 0) });
    },
    reservation: async (wsid, id) => state.reservations.find((r) => same(r.workspaceId, wsid) && same(r.attemptId, id)),
    resolveReservation: async (record, status, at) => {
      const fresh = find("reservations", record.workspaceId, record._id);
      return fresh?.status === "held" ? update("reservations", fresh, { status, resolvedAt: at }) : null;
    },
    resolveStock: async (wsid, item, consume) => {
      const product = find("products", wsid, item.productId);
      if (!product || product.stockReserved < item.quantity || (consume && product.stockOnHand < item.quantity)) return null;
      return update("products", product, { stockReserved: product.stockReserved - item.quantity, stockOnHand: product.stockOnHand - (consume ? item.quantity : 0), revision: product.revision + 1 });
    },
    claimAttempt: async (wsid, id, owner, at) => {
      const a = find("attempts", wsid, id);
      return a && (!a.leaseUntil || a.leaseUntil <= at) ? update("attempts", a, { leaseOwner: owner, leaseUntil: new Date(at.getTime() + 300000), revision: a.revision + 1 }) : null;
    },
    updateAttempt: async (record, patch, _session, release = true) => {
      const a = find("attempts", record.workspaceId, record._id);
      if (!a || a.revision !== record.revision || a.leaseOwner !== record.leaseOwner) return null;
      return update("attempts", a, { ...patch, ...(release ? { leaseOwner: "", leaseUntil: null } : {}), revision: a.revision + 1 });
    },
    requestCancel: async (wsid, id, at) => { const a = find("attempts", wsid, id); return a?.active ? update("attempts", a, { cancelRequestedAt: at, paymentUrl: "", nextCheckAt: at }) : null; },
    payment: async (wsid, gid, pid) => state.payments.find((p) => same(p.workspaceId, wsid) && same(p.gatewayConnectionId, gid) && p.providerPaymentId === pid),
    paymentById: async (wsid, id) => find("payments", wsid, id), createPayment: async (fields) => create("payments", "CommercePayment", fields),
    updatePayment: async (record, patch) => { const p = find("payments", record.workspaceId, record._id);
      return p ? update("payments", p, { ...patch, refundedPaise: Math.max(p.refundedPaise, patch.refundedPaise || 0) }) : null; },
    refund: async (wsid, gid, rid) => state.refunds.find((r) => same(r.workspaceId, wsid) && same(r.gatewayConnectionId, gid) && r.providerRefundId === rid),
    createRefund: async (fields) => create("refunds", "CommerceRefund", fields),
    updateRefund: async (record, patch) => update("refunds", record, patch),
    outbox: async (fields) => state.notifications.find((r) => same(r.workspaceId, fields.workspaceId) && r.key === fields.key) || create("notifications", "CommerceOutbox", fields),
    expiredReservations: async (at) => state.reservations.filter((r) => r.status === "held" && r.expiresAt <= at),
    dueAttempts: async (at) => state.attempts.filter((a) => a.nextCheckAt <= at && (!a.leaseUntil || a.leaseUntil <= at)),
    duePayments: async (at) => state.payments.filter((p) => p.nextCheckAt <= at),
    pendingOutbox: async () => state.notifications.filter((r) => r.status === "pending"),
    claimOutbox: async (wsid, id, at) => { const r = find("notifications", wsid, id); return r?.status === "pending" ? update("notifications", r, { status: "sending", startedAt: at }) : null; },
    finishOutbox: async (record, patch) => { const r = find("notifications", record.workspaceId, record._id); return r?.status === "sending" ? update("notifications", r, patch) : null; },
    expireOutbox: async (at) => { for (const r of state.notifications) if (r.status === "sending" && r.startedAt <= new Date(at.getTime() - 300000)) update("notifications", r, { status: "unknown" }); },
    eventCandidates: async (at) => state.events.filter((e) => e.kind === "razorpay" && e.status === "pending" && e.nextAttemptAt <= at),
    claimEvent: async (wsid, id, owner, at) => { const e = find("events", wsid, id); return e?.kind === "razorpay" && e.status === "pending" ? update("events", e, { status: "processing", leaseOwner: owner, attempts: e.attempts + 1, leaseUntil: new Date(at.getTime() + 300000) }) : null; },
    finishEvent: async (record, patch) => { const e = find("events", record.workspaceId, record._id); return e?.kind === "razorpay" && e.leaseOwner === record.leaseOwner ? update("events", e, { ...patch, leaseOwner: "", leaseUntil: null }) : null; },
    attemptsForOrder: async (wsid, id, query) => state.attempts.filter((a) => same(a.workspaceId, wsid) && same(a.orderId, id)).slice(0, query.limit + 1),
    listPayments: async (wsid, q) => state.payments.filter((p) => same(p.workspaceId, wsid) && p.environment === q.environment).slice(0, q.limit + 1),
    listRefunds: async (wsid, id, q) => state.refunds.filter((r) => same(r.workspaceId, wsid) && same(r.paymentId, id)).slice(0, q.limit + 1),
  };
  const gateways = {
    getMerchantAuthentication: async (wsid, id, environment) => { calls.newAuth.push([String(wsid), String(id), environment]);
      const g = await repo.gateway(wsid, id); if (!g?.active || g.status !== "connected" || g.environment !== environment) throw new Error("unavailable"); return { merchant: String(id) }; },
    getReconciliationAuthentication: async (wsid, id, environment) => { calls.readAuth.push([String(wsid), String(id), environment]);
      const g = await repo.gateway(wsid, id); if (!g || g.status === "revoked" || g.environment !== environment) throw new Error("unavailable"); return { merchant: String(id) }; },
  };
  const provider = {
    createLink: async (_auth, data) => { calls.create++; const link = { ...data, id: `plink_Test${calls.create}`, amount_paid: 0, status: "created", short_url: "https://rzp.io/i/test", payments: [] };
      state.providerLinks.push(link); return link; },
    fetchLink: async (_auth, id) => { calls.fetch++; return state.providerLinks.find((l) => l.id === id); },
    findLink: async (_auth, reference) => ({ payment_links: state.providerLinks.filter((l) => l.reference_id === reference) }),
    findLinkForPayment: async (_auth, id) => ({ payment_links: state.providerLinks.filter((l) => l.payments.some((p) => p.payment_id === id)) }),
    fetchPayment: async (_auth, id) => state.providerPayments.find((p) => p.id === id),
    fetchOrder: async (_auth, id) => ({ id, amount: state.orders[0].totalPaise, amount_paid: state.orders[0].totalPaise, currency: "INR", status: "paid" }),
    cancelLink: async (_auth, id) => { calls.cancel++; const i = state.providerLinks.findIndex((l) => l.id === id); state.providerLinks[i] = { ...state.providerLinks[i], status: "cancelled" }; return state.providerLinks[i]; },
    fetchRefund: async (_auth, id) => state.providerRefunds.find((r) => r.id === id),
    fetchRefunds: async (_auth, id, skip) => { const items = state.providerRefunds.filter((r) => r.payment_id === id).slice(skip, skip + 25); return { entity: "collection", count: items.length, items }; },
  };
  const recovery = createPaymentRecovery({ repo, provider, gateways, config, now, authorize: async () => {} });
  const service = createPaymentsService({ repo, gateways, config, now, authorize: async () => {}, reconcile: recovery.reconcile });
  const webhooks = createPaymentWebhooks({ repo, recovery, gateways, provider, config, now, authorize: async () => {} });
  const send = async (input) => { calls.send++; calls.lastMessage = input; return { message: { whatsappMessageId: "wamid.confirmation" } }; };
  const outbox = createPaymentOutbox({ repo, config, now, authorize: async () => {}, send });
  const input = () => ({ revision: state.orders[0].revision, gatewayConnectionId: gatewayId, idempotencyKey: "checkout_test_key_01" });
  const checkout = () => service.checkout(ws, state.orders[0]._id, userId, input());
  const pay = (attempt = state.attempts[0], id = "pay_Test1") => {
    const i = state.providerLinks.findIndex((l) => l.reference_id === attempt.reference), link = state.providerLinks[i];
    const payment = { entity: "payment", id, amount: attempt.amountPaise, amount_refunded: 0, currency: "INR", status: "captured", captured: true, order_id: "order_Test1", method: "upi" };
    state.providerPayments.push(payment); state.providerLinks[i] = { ...link, status: "paid", order_id: payment.order_id, amount_paid: payment.amount,
      payments: [...link.payments, { payment_id: id, status: "captured" }] }; return payment;
  };
  return { ...f, state, repo, config, flags, calls, gateways, provider, recovery, service, webhooks, outbox, send, input, checkout, pay, update };
}
module.exports = { fixture, ws, otherWs, gatewayId, userId };
