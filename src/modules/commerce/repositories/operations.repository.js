const base = require("./payments.repository");
const { CommerceOrder: Order, CommerceProduct: Product, CommerceInventoryReservation: Reservation, CommerceOutbox: Outbox, CommercePayment: Payment } = require("../models");
const { byWorkspace } = require("./scope");
const options = (session) => ({ returnDocument: "after", runValidators: true, ...(session ? { session } : { writeConcern: { w: "majority", j: true, wtimeout: 10000 } }) });
function productsById(ws, catalogId, ids) {
  return Product.find(byWorkspace(ws, { catalogConnectionId: catalogId, _id: { $in: ids } })).read("primary").limit(30).lean();
}
function catalogThumbnail(ws, catalogId) {
  return Product.findOne(byWorkspace(ws, { catalogConnectionId: catalogId, available: true, archivedAt: null, syncStatus: "synced",
    $expr: { $and: [{ $eq: ["$syncedRevision", "$revision"] }, { $or: [{ $eq: ["$trackInventory", false] }, { $gt: ["$stockOnHand", "$stockReserved"] }] }] } }))
    .read("primary").sort({ _id: 1 }).lean();
}
function hasPaymentIssue(ws, orderId, session) {
  return Payment.exists(byWorkspace(ws, { orderId, $or: [{ refundedPaise: { $gt: 0 } }, { overpayment: true }] })).session(session);
}
async function allocateStock(ws, item, now, session) {
  const product = await Product.findOne(byWorkspace(ws, { _id: item.productId })).session(session).lean();
  if (product?.inventoryOutletId) await require("../delivery/inventory").change(ws, product, item, "allocate", session);
  return Product.findOneAndUpdate(byWorkspace(ws, { _id: item.productId, trackInventory: true, available: true, archivedAt: null,
    $expr: { $gte: [{ $subtract: ["$stockOnHand", "$stockReserved"] }, item.quantity] } }),
    { $inc: { stockOnHand: -item.quantity, revision: 1 }, $set: { syncStatus: "pending", syncNextAttemptAt: now, syncError: "" } }, options(session)).lean();
}
function allocateReservation(record, now, session) {
  return Reservation.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, status: "released" }),
    { $set: { status: "consumed", resolvedAt: now } }, options(session)).lean();
}
function notification(ws, id) { return Outbox.findOne(byWorkspace(ws, { _id: id })).read("primary").select("+payloadEnc").lean(); }
function retryNotification(record, payloadEnc) {
  return Outbox.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, status: "blocked", startedAt: record.startedAt }),
    { $set: { status: "pending", payloadEnc, startedAt: null, lastError: "" } }, options()).lean();
}
function inboxOrders(ws, { environment, to, cursor, limit }, credentials) {
  return Order.find(byWorkspace(ws, { environment, customerPhone: to, wabaId: credentials.wabaId, phoneNumberId: credentials.phoneNumberId,
    ...(cursor ? { _id: { $lt: cursor } } : {}) })).sort({ _id: -1 }).limit(limit + 1).lean();
}
module.exports = { ...base, productsById, catalogThumbnail, hasPaymentIssue, allocateStock, allocateReservation, notification, retryNotification, inboxOrders };
