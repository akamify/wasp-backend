const mongoose = require("mongoose");
const { CommerceOrder: Order } = require("@infra/database/CommerceOrder");
const { CommerceEvent: Event } = require("@infra/database/CommerceEvent");
const { CommerceProduct: Product } = require("@infra/database/CommerceProduct");
const { CommerceCatalogConnection: Catalog } = require("@infra/database/CommerceCatalogConnection");
const { CommerceSettings: Settings } = require("@infra/database/CommerceSettings");
const { CommerceSession: Session } = require("@infra/database/CommerceSession");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { Workspace } = require("@infra/database/Workspace");
const { byWorkspace } = require("./scope");
const writeConcern = { w: "majority", j: true, wtimeout: 10000 };
const options = (session) => ({ returnDocument: "after", runValidators: true, ...(session ? { session } : { writeConcern }) });
const querySession = (query, session) => session ? query.session(session) : query.read("primary");
const transaction = (work) => mongoose.connection.transaction(work, { readPreference: "primary", readConcern: { level: "snapshot" }, writeConcern });
function exactTenants(wabaId, phoneNumberId) {
  return WhatsAppCredentials.find({ businessAccountIdPlain: wabaId, phoneNumberIdPlain: phoneNumberId, status: "active", isActive: { $ne: false } })
    .read("primary").limit(2).select("workspaceId").lean();
}
function connectionMatches(workspaceId, wabaId, phoneNumberId, session) {
  return querySession(WhatsAppCredentials.exists(byWorkspace(workspaceId, { businessAccountIdPlain: wabaId,
    phoneNumberIdPlain: phoneNumberId, status: "active", isActive: { $ne: false } })), session);
}
function workspaceActive(workspaceId, session) {
  return querySession(Workspace.exists({ _id: workspaceId, isActive: true, status: "active" }), session);
}
function settings(workspaceId, session) { return querySession(Settings.findOne(byWorkspace(workspaceId)), session).lean(); }
async function saveSettings(workspaceId, revision, patch) {
  if (revision === 0) { const [record] = await Settings.create([{ workspaceId, ...patch }], { writeConcern }); return record; }
  return Settings.findOneAndUpdate(byWorkspace(workspaceId, { revision }), { $set: patch, $inc: { revision: 1 } }, options()).lean();
}
function catalog(workspaceId, filter, session) {
  return querySession(Catalog.findOne(byWorkspace(workspaceId, { ...filter, active: true, status: "connected" })), session).lean();
}
function products(workspaceId, catalogConnectionId, skus, session) {
  return querySession(Product.find(byWorkspace(workspaceId, { catalogConnectionId, sku: { $in: skus } })), session).limit(100).lean();
}
function order(workspaceId, id, session) {
  return querySession(Order.findOne(byWorkspace(workspaceId, { _id: id })), session).select("+addressEnc +customerNoteEnc").lean();
}
function existingOrder(workspaceId, wabaId, inboundMessageId, session) {
  return querySession(Order.findOne(byWorkspace(workspaceId, { wabaId, inboundMessageId })), session).lean();
}
async function createOrder(fields, session) {
  const [record] = await Order.create([fields], { session });
  if (process.env.COMMERCE_DELIVERY_ENABLED === "true") await require("../delivery/models").Notice.create([{ workspaceId: fields.workspaceId, environment: fields.environment, orderId: record._id, kind: "new_order", key: `new-order:${record._id}` }], { session });
  return record;
}
function updateOrder(workspaceId, id, revision, patch, session) {
  return Order.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, revision, status: { $in: ["needs_details", "needs_review"] },
    paymentStatus: "unpaid", activeAttemptId: null, paidAttemptId: null }),
    { $set: patch, $inc: { revision: 1 } }, options(session)).select("+addressEnc +customerNoteEnc").lean();
}
function listOrders(workspaceId, { environment, status, cursor, limit }) {
  return Order.find(byWorkspace(workspaceId, { environment, ...(status ? { status } : {}), ...(cursor ? { _id: { $lt: cursor } } : {}) }))
    .sort({ _id: -1 }).limit(limit + 1).lean();
}
async function persistEvent(fields) {
  try {
    return await Event.findOneAndUpdate(byWorkspace(fields.workspaceId, { eventKey: fields.eventKey }),
      { $setOnInsert: fields }, { upsert: true, ...options() }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await Event.findOne(byWorkspace(fields.workspaceId, { eventKey: fields.eventKey })).read("primary").lean();
    if (!existing) throw error;
    return existing;
  }
}
function eventCandidates(now) {
  return Event.find({ kind: "whatsapp.order", nextAttemptAt: { $lte: now },
    $or: [{ status: "pending" }, { status: "processing", leaseUntil: { $lte: now } }] })
    .sort({ nextAttemptAt: 1 }).limit(20).select("workspaceId").lean();
}
function claimEvent(workspaceId, id, owner, now) {
  return Event.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, kind: "whatsapp.order", nextAttemptAt: { $lte: now },
    $or: [{ status: "pending" }, { status: "processing", leaseUntil: { $lte: now } }] }),
    { $set: { status: "processing", leaseOwner: owner, leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, options())
    .select("+payloadEnc").lean();
}
function finishEvent(event, patch, session) {
  return Event.findOneAndUpdate(byWorkspace(event.workspaceId, { _id: event._id, kind: "whatsapp.order", status: "processing", leaseOwner: event.leaseOwner }),
    { $set: { ...patch, leaseOwner: "", leaseUntil: null } }, options(session)).lean();
}
function listEvents(workspaceId, { status, cursor, limit }) {
  return Event.find(byWorkspace(workspaceId, { kind: "whatsapp.order", status, ...(cursor ? { _id: { $lt: cursor } } : {}) }))
    .sort({ _id: -1 }).limit(limit + 1).lean();
}
function retryEvent(workspaceId, id, now) {
  return Event.findOneAndUpdate(byWorkspace(workspaceId, { _id: id, kind: "whatsapp.order", status: "dead_letter" }),
    { $set: { status: "pending", attempts: 0, nextAttemptAt: now, leaseUntil: null, leaseOwner: "", lastError: "" } }, options()).lean();
}
async function createSession(fields) { const [record] = await Session.create([fields], { writeConcern }); return record; }
function findSession(tokenHash, now, session) {
  return querySession(Session.findOne({ kind: "fulfillment", tokenHash, usedAt: null, expiresAt: { $gt: now } }), session).select("+dataEnc").lean();
}
function consumeSession(record, now, session) {
  return Session.findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, kind: "fulfillment", orderId: record.orderId,
    usedAt: null, expiresAt: { $gt: now } }), { $set: { usedAt: now } }, options(session)).lean();
}
module.exports = { transaction, exactTenants, connectionMatches, workspaceActive, settings, saveSettings, catalog, products,
  order, existingOrder, createOrder, updateOrder, listOrders, persistEvent, eventCandidates, claimEvent, finishEvent,
  listEvents, retryEvent, createSession, findSession, consumeSession };
