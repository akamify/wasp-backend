const { transaction } = require("../repositories/orders.repository");
const { byWorkspace } = require("../repositories/scope");
const models = require("./models");
const opts = (session) => ({ ...(session ? { session } : { writeConcern: { w: "majority", j: true, wtimeout: 10000 } }), new: true, runValidators: true });
const query = (q, session) => q.session(session || null).lean();
const secretFields = "+pinHash +pinEnc +trackingHash +pickupEnc +destinationEnc";
const get = (kind, ws, id, session) => query(models[kind].findOne(byWorkspace(ws, { _id: id })).select(kind === "Delivery" ? secretFields : ""), session);
const create = async (kind, fields, session) => (await models[kind].create([fields], session ? { session } : { writeConcern: { w: "majority", j: true, wtimeout: 10000 } }))[0].toObject();
const update = (kind, record, patch, session) => query(models[kind].findOneAndUpdate(byWorkspace(record.workspaceId, { _id: record._id, revision: record.revision }),
  { $set: patch, $inc: { revision: 1 } }, opts(session)).select(kind === "Delivery" ? secretFields : ""), session);
const list = (kind, ws, { cursor, limit, ...filter }, session) => query(models[kind].find(byWorkspace(ws, { ...filter, ...(cursor ? { _id: { $lt: cursor } } : {}) }))
  .select(kind === "Delivery" ? "+pickupEnc +destinationEnc" : "").sort({ _id: -1 }).limit(limit + 1), session);
const byOrder = (ws, id, session) => query(models.Delivery.findOne(byWorkspace(ws, { orderId: id })).select(secretFields), session);
const byUser = (userId, session) => query(models.Courier.findOne({ userId }), session);
async function notice(record, kind, actorId, reason, session, recipientId = null) {
  await models.Notice.updateOne({ workspaceId: record.workspaceId, key: `${record._id}:${record.revision}:${kind}:${recipientId || "merchant"}` },
    { $setOnInsert: { workspaceId: record.workspaceId, environment: record.environment, deliveryId: record._id, orderId: record.orderId, kind, actorId: actorId || "", reason: reason || "", recipientId,
      key: `${record._id}:${record.revision}:${kind}:${recipientId || "merchant"}` } }, { session, upsert: true, runValidators: true });
}
module.exports = { ...models, get, create, update, list, byOrder, byUser, notice, transaction, query };
