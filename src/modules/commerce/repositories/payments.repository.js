const models = require("../models");
const { CommerceCheckoutAttempt: Attempt, CommerceInventoryReservation: Reservation, CommerceProduct: Product,
  CommerceOrder: Order, CommerceGatewayConnection: Gateway, CommercePayment: Payment, CommerceRefund: Refund,
  CommerceEvent: Event, CommerceOutbox: Outbox } = models;
const orders = require("./orders.repository");
const { byWorkspace } = require("./scope");
const writeConcern = { w: "majority", j: true, wtimeout: 10000 };
const options = (session) => ({ returnDocument: "after", runValidators: true, ...(session ? { session } : { writeConcern }) });
const query = (q, session) => (session ? q.session(session) : q.read("primary")).lean();
const create = async (Model, fields, session) => (await Model.create([fields], session ? { session } : { writeConcern }))[0].toObject();
const scoped = (Model, ws, filter, session, select = "") => query(Model.findOne(byWorkspace(ws, filter)).select(select), session);
function gateway(ws, id, session) { return scoped(Gateway, ws, { _id: id }, session, "+webhookSecretEnc +previousWebhookSecretEnc"); }
// Public routing discovers only the immutable connection; request/payload workspace fields have no authority.
function webhookGateway(id) { return query(Gateway.findById(id).select("+webhookSecretEnc +previousWebhookSecretEnc")); }
function updateGateway(record, patch, session) {
  return Gateway.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, revision: record.revision }),
    { $set: patch, $inc: { revision: 1 } }, options(session)).lean();
}
function fenceGateway(record, session) {
  return Gateway.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, revision: record.revision, active: true, status: "connected" }),
    { $inc: { revision: 1 } }, options(session)).lean();
}
const attempt = (ws, id, session) => scoped(Attempt, ws, { _id: id }, session, "+leaseOwner");
const byKey = (ws, idempotencyKey, session) => scoped(Attempt, ws, { idempotencyKey }, session);
const byReference = (ws, gatewayConnectionId, reference) => scoped(Attempt, ws, { gatewayConnectionId, reference });
const byLink = (ws, gatewayConnectionId, providerLinkId) => scoped(Attempt, ws, { gatewayConnectionId, providerLinkId });
// reference is globally unique; all original asset bindings must also match.
function scheduleNative(reference, wabaId, phoneNumberId, now) {
  return Attempt.updateOne({ reference, mode: "whatsapp_native", nativeWabaId: wabaId, nativePhoneNumberId: phoneNumberId },
    { $min: { nextCheckAt: now } }, { writeConcern });
}
const attemptsForOrder = (ws, orderId, { cursor, limit }) => query(Attempt.find(byWorkspace(ws,
  { orderId, ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1));
function transitionOrder(order, patch, session) {
  return Order.findOneAndUpdate(byWorkspace(order.workspaceId, { _id: order._id, revision: order.revision }),
    { $set: patch, $inc: { revision: 1 } }, options(session)).lean();
}
async function reserveProduct(ws, product, quantity, now, session, outletId) {
  if (product.inventoryOutletId) await require("../delivery/inventory").change(ws, product, { quantity, outletId }, "reserve", session);
  const tracked = product.trackInventory;
  return Product.findOneAndUpdate(byWorkspace(ws, { _id: product._id, revision: product.revision, available: true, archivedAt: null,
    ...(tracked ? { trackInventory: true, $expr: { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, quantity] } } : { trackInventory: false }) }),
    { $inc: { revision: 1, ...(tracked ? { stockReserved: quantity } : {}) },
      $set: { syncStatus: "pending", syncNextAttemptAt: now, syncError: "" } }, options(session)).lean();
}
const reservation = (ws, attemptId, session) => scoped(Reservation, ws, { attemptId }, session);
function resolveReservation(record, status, now, session) {
  return Reservation.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, status: "held" }),
    { $set: { status, resolvedAt: now } }, options(session)).lean();
}
async function resolveStock(ws, item, consume, now, session) {
  const product = await scoped(Product, ws, { _id: item.productId }, session);
  if (product?.inventoryOutletId) await require("../delivery/inventory").change(ws, product, item, consume ? "consume" : "release", session);
  return Product.findOneAndUpdate(byWorkspace(ws, { _id: item.productId, trackInventory: true, stockReserved: { $gte: item.quantity },
    ...(consume ? { stockOnHand: { $gte: item.quantity } } : {}) }),
    { $inc: { stockReserved: -item.quantity, ...(consume ? { stockOnHand: -item.quantity } : {}), revision: 1 },
      $set: { syncStatus: "pending", syncNextAttemptAt: now, syncError: "" } }, options(session)).lean();
}
const expiredReservations = (now) => query(Reservation.find({ status: "held", expiresAt: { $lte: now } }).sort({ expiresAt: 1 }).limit(25).select("workspaceId attemptId"));
const dueAttempts = (now) => query(Attempt.find({ nextCheckAt: { $lte: now }, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] })
  .sort({ nextCheckAt: 1 }).limit(20).select("workspaceId"));
function claimAttempt(ws, id, owner, now) {
  return Attempt.findOneAndUpdate(byWorkspace(ws, { _id: id, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }),
    { $set: { leaseOwner: owner, leaseUntil: new Date(now.getTime() + 300000) }, $inc: { revision: 1 } }, options()).select("+leaseOwner").lean();
}
function updateAttempt(record, patch, session, release = true) {
  return Attempt.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, revision: record.revision, leaseOwner: record.leaseOwner }),
    { $set: { ...patch, ...(release ? { leaseOwner: "", leaseUntil: null } : {}) }, $inc: { revision: 1 } }, options(session)).select("+leaseOwner").lean();
}
function requestCancel(ws, id, now, session) {
  // A cancellation intent can race with a worker, but cannot be overwritten by it.
  return Attempt.findOneAndUpdate(byWorkspace(ws, { _id: id, active: true, status: { $ne: "captured" } }),
    { $set: { cancelRequestedAt: now, paymentUrl: "", nextCheckAt: now } }, options(session)).lean();
}
const payment = (ws, gatewayConnectionId, providerPaymentId, session) => scoped(Payment, ws, { gatewayConnectionId, providerPaymentId }, session);
const paymentById = (ws, id, session) => scoped(Payment, ws, { _id: id }, session);
const listPayments = (ws, { environment, cursor, limit }) => query(Payment.find(byWorkspace(ws,
  { environment, ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1));
const duePayments = (now) => query(Payment.find({ nextCheckAt: { $lte: now } }).sort({ nextCheckAt: 1 }).limit(10).select("workspaceId"));
function updatePayment(record, patch, session) {
  const { refundedPaise, ...rest } = patch;
  return Payment.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id }),
    { $set: rest, ...(refundedPaise === undefined ? {} : { $max: { refundedPaise } }) }, options(session)).lean();
}
const refund = (ws, gatewayConnectionId, providerRefundId, session) => scoped(Refund, ws, { gatewayConnectionId, providerRefundId }, session);
function updateRefund(record, patch, session) {
  return Refund.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, status: record.status }), { $set: patch }, options(session)).lean();
}
const listRefunds = (ws, paymentId, { cursor, limit }) => query(Refund.find(byWorkspace(ws,
  { paymentId, ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1));
const eventCandidates = (now) => query(Event.find({ kind: "razorpay", nextAttemptAt: { $lte: now },
  $or: [{ status: "pending" }, { status: "processing", leaseUntil: { $lte: now } }] }).sort({ nextAttemptAt: 1 }).limit(20).select("workspaceId"));
function claimEvent(ws, id, owner, now) {
  return Event.findOneAndUpdate(byWorkspace(ws, { _id: id, kind: "razorpay", nextAttemptAt: { $lte: now },
    $or: [{ status: "pending" }, { status: "processing", leaseUntil: { $lte: now } }] }),
    { $set: { status: "processing", leaseOwner: owner, leaseUntil: new Date(now.getTime() + 300000) }, $inc: { attempts: 1 } }, options()).select("+payloadEnc").lean();
}
function finishEvent(record, patch) {
  return Event.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, kind: "razorpay", status: "processing", leaseOwner: record.leaseOwner }),
    { $set: { ...patch, leaseOwner: "", leaseUntil: null } }, options()).lean();
}
const listEvents = (ws, { status, cursor, limit }) => query(Event.find(byWorkspace(ws,
  { kind: "razorpay", status, ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1));
function retryEvent(ws, id, now) {
  return Event.findOneAndUpdate(byWorkspace(ws, { _id: id, kind: "razorpay", status: "dead_letter" }),
    { $set: { status: "pending", attempts: 0, nextAttemptAt: now, leaseUntil: null, leaseOwner: "", lastError: "" } }, options()).lean();
}
function outbox(fields, session) {
  return Outbox.findOneAndUpdate(byWorkspace(fields.workspaceId, { key: fields.key }), { $setOnInsert: fields }, { upsert: true, ...options(session) }).lean();
}
const pendingOutbox = () => query(Outbox.find({ status: "pending" }).sort({ createdAt: 1 }).limit(20).select("workspaceId"));
function claimOutbox(ws, id, now) {
  return Outbox.findOneAndUpdate(byWorkspace(ws, { _id: id, status: "pending" }),
    { $set: { status: "sending", startedAt: now } }, options()).select("+payloadEnc").lean();
}
function finishOutbox(record, patch) {
  return Outbox.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, status: "sending", startedAt: record.startedAt }),
    { $set: patch }, options()).lean();
}
function expireOutbox(now) {
  return Outbox.updateMany({ status: "sending", startedAt: { $lte: new Date(now.getTime() - 300000) } },
    { $set: { status: "unknown", lastError: "notification_delivery_unknown" } }, { writeConcern });
}
const listOutbox = (ws, orderId, { cursor, limit }) => query(Outbox.find(byWorkspace(ws,
  { orderId, ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1));
module.exports = { ...orders, gateway, webhookGateway, updateGateway, fenceGateway, attempt, byKey, byReference, byLink, scheduleNative, attemptsForOrder,
  createAttempt: (fields, session) => create(Attempt, fields, session), createReservation: (fields, session) => create(Reservation, fields, session),
  createPayment: (fields, session) => create(Payment, fields, session), createRefund: (fields, session) => create(Refund, fields, session),
  transitionOrder, reserveProduct, reservation, resolveReservation, resolveStock, expiredReservations,
  dueAttempts, claimAttempt, updateAttempt, requestCancel, payment, paymentById, listPayments, duePayments, updatePayment,
  refund, updateRefund, listRefunds, eventCandidates, claimEvent, finishEvent, listEvents, retryEvent,
  outbox, pendingOutbox, claimOutbox, finishOutbox, expireOutbox, listOutbox };
