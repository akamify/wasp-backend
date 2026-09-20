const repo = require("./repository"), service = require("./service"), d = require("./domain");
const google = require("./googleRoutes"), settings = require("./routingSettings");
const orders = require("../repositories/orders.repository");

function stocked(outletId, items, stocks) {
  const quantities = new Map();
  for (const item of items) quantities.set(String(item.productId), (quantities.get(String(item.productId)) || 0) + item.quantity);
  const available = new Map(stocks.filter((s) => String(s.outletId) === String(outletId)).map((s) => [String(s.productId), s]));
  return [...quantities].every(([id, quantity]) => { const s = available.get(id); return s?.available && s.stockOnHand - s.stockReserved >= quantity; });
}
async function recommendations(ws, id, revision) {
  await require("./readiness").routingReady();
  const order = await orders.order(ws, id); if (!order) d.fail("Order not found.", 404);
  d.editable(order, revision);
  const destination = service.open(order, "addressEnc")?.location;
  if (order.fulfillmentMethod !== "delivery" || !destination?.confirmedAt || !google.validPoint(destination)) d.fail("Confirm the customer delivery pin first.");
  const outlets = await repo.Outlet.find({ workspaceId: ws, active: true }).sort({ _id: 1 }).limit(101).lean();
  if (outlets.length > 100) d.fail("Automatic branch selection supports up to 100 active branches. Select a branch manually.");
  const eligible = outlets.filter((o) => service.isOpen(o) && google.validPoint(o) && d.distance(o, destination) <= o.radiusMetres);
  const stocks = await repo.Stock.find({ workspaceId: ws, outletId: { $in: eligible.map((o) => o._id) }, productId: { $in: order.items.map((i) => i.productId) } }).lean();
  const config = await settings.get(ws);
  const shortlist = eligible.filter((o) => stocked(o._id, order.items, stocks)).sort((a, b) => d.distance(a, destination) - d.distance(b, destination) || String(a._id).localeCompare(String(b._id))).slice(0, config.routeShortlist);
  if (!shortlist.length) return { candidates: [], suggestedOutletId: null, orderRevision: order.revision };
  const matrix = await google.matrix(shortlist, [destination], "car");
  const candidates = shortlist.flatMap((o, i) => { const route = matrix.get(`${i}:0`); return route ? [{ outletId: String(o._id), name: o.name, prepMinutes: o.prepMinutes, roadMetres: route.metres, etaSeconds: route.seconds, fallback: route.fallback }] : []; });
  candidates.sort((a, b) => a.roadMetres - b.roadMetres || a.etaSeconds - b.etaSeconds || a.outletId.localeCompare(b.outletId));
  return { candidates, suggestedOutletId: candidates[0]?.outletId || null, orderRevision: order.revision, provider: "Google Maps", generatedAt: new Date().toISOString() };
}
async function run() {
  if (!settings.routingEnabled() || !d.newEnabled()) return { disabled: true };
  await require("./readiness").routingReady();
  const { CommerceOrder } = require("../models"), now = new Date();
  const due = { branchRoutingStatus: "pending", manualDeliveryId: null, fulfillmentMethod: "delivery", paymentStatus: "unpaid", status: { $in: ["needs_review", "needs_details"] }, activeAttemptId: null, paidAttemptId: null,
    $or: [{ branchRoutingNextAt: null }, { branchRoutingNextAt: { $lte: now } }] };
  const rows = await CommerceOrder.aggregate([{ $match: due }, { $sort: { branchRoutingNextAt: 1, _id: 1 } },
    { $lookup: { from: repo.RoutingSettings.collection.name, localField: "workspaceId", foreignField: "workspaceId", pipeline: [{ $match: { branchAutoSelect: true } }, { $project: { _id: 1 } }], as: "config" } },
    { $match: { "config.0": { $exists: true } } }, { $limit: 5 }, { $project: { _id: 1, workspaceId: 1, revision: 1 } }]).option({ maxTimeMS: 3000 });
  let processed = 0;
  for (const row of rows) {
    const token = require("node:crypto").randomUUID();
    const claimed = await CommerceOrder.findOneAndUpdate({ ...due, _id: row._id, workspaceId: row.workspaceId, revision: row.revision },
      { $set: { branchRoutingToken: token, branchRoutingNextAt: new Date(Date.now() + 60000) }, $inc: { branchRoutingAttempts: 1 } }, { new: true, writeConcern: { w: "majority" } }).lean();
    if (!claimed) continue;
    let result;
    try { if (!await orders.workspaceActive(row.workspaceId)) continue; result = await recommendations(row.workspaceId, row._id, row.revision); }
    catch { if (claimed.branchRoutingAttempts < 3) continue; result = { suggestedOutletId: null }; }
    await repo.transaction(async (session) => {
      const config = await settings.get(row.workspaceId, session); if (!config.branchAutoSelect) return;
      const fenced = await repo.RoutingSettings.updateOne({ workspaceId: row.workspaceId, revision: config.revision, branchAutoSelect: true }, { $inc: { dispatchFence: 1 } }, { session });
      if (fenced.modifiedCount !== 1) return;
      const updated = await CommerceOrder.updateOne({ _id: row._id, workspaceId: row.workspaceId, revision: row.revision, branchRoutingToken: token, branchRoutingStatus: "pending", manualDeliveryId: null,
        fulfillmentMethod: "delivery", paymentStatus: "unpaid", activeAttemptId: null, paidAttemptId: null, status: { $in: ["needs_details", "needs_review"] } },
        { $set: { recommendedOutletId: result.suggestedOutletId, branchRoutingStatus: result.suggestedOutletId ? "suggested" : "manual", branchRoutingToken: "" }, $inc: { revision: 1 } }, { session });
      if (!updated.modifiedCount) return;
      await repo.Notice.updateOne({ workspaceId: row.workspaceId, key: `branch:${row._id}:${row.revision}` }, { $setOnInsert: {
        workspaceId: row.workspaceId, key: `branch:${row._id}:${row.revision}`, orderId: row._id, deliveryId: null, recipientId: null, environment: claimed.environment,
        kind: result.suggestedOutletId ? "branch_acceptance_required" : "branch_manual_selection_required", actorId: "system:branch-selection",
        reason: result.suggestedOutletId ? "Nearest eligible branch selected. Restaurant acceptance is required." : "Automatic branch selection unavailable. Select a branch manually." } }, { upsert: true, session });
      processed++;
    });
  }
  return { processed };
}
async function current(ws, id) {
  const o = await orders.order(ws, id); if (!o) d.fail("Order not found.", 404);
  const outlet = o.recommendedOutletId ? await repo.get("Outlet", ws, o.recommendedOutletId) : null;
  return { status: o.branchRoutingStatus || "manual", outletId: outlet ? String(outlet._id) : null, name: outlet?.name, prepMinutes: outlet?.prepMinutes };
}
async function dashboard(ws, outletId, query) {
  await require("./readiness").routingReady();
  const outlet = await service.required("Outlet", ws, outletId), config = await settings.get(ws), now = new Date(), cutoff = new Date(now - config.locationMaxAgeSeconds * 1000);
  const mongoose = require("mongoose"), { CommerceOrder } = require("../models");
  const rows = await CommerceOrder.find({ workspaceId: ws, recommendedOutletId: outletId, environment: query.environment, manualDeliveryId: null, paymentStatus: "unpaid", status: { $in: ["needs_details", "needs_review"] }, ...(query.cursor ? { _id: { $lt: query.cursor } } : {}) }).select("orderNumber revision status").sort({ _id: -1 }).limit(query.limit + 1).lean();
  const counts = await repo.Courier.aggregate([{ $geoNear: { key: "geoPoint", near: { type: "Point", coordinates: [outlet.longitude, outlet.latitude] }, spherical: true, maxDistance: config.pickupRadiusMetres, distanceField: "distance", query: {
    workspaceId: new mongoose.Types.ObjectId(String(ws)), allowedOutletIds: outlet._id, active: true, online: true, currentDeliveryId: null, vehicle: { $in: config.allowedVehicles },
    "location.capturedAt": { $gte: cutoff, $lte: now }, "location.receivedAt": { $gte: cutoff, $lte: now }, "location.accuracy": { $gte: 0, $lte: config.maxAccuracyMetres },
    $expr: { $lt: [{ $ifNull: ["$batchLoad", 0] }, { $ifNull: ["$batchCapacity", 1] }] } } } },
    { $match: { $expr: { $lte: ["$distance", { $ifNull: ["$pickupRadiusMetres", config.pickupRadiusMetres] }] } } },
    { $lookup: { from: repo.Trip.collection.name, localField: "currentTripId", foreignField: "_id", as: "trip" } },
    { $match: { $or: [{ currentTripId: null }, { "trip.0.status": "loading", "trip.0.outletId": outlet._id, "trip.0.environment": query.environment }] } },
    { $facet: { totals: [{ $group: { _id: null, couriers: { $sum: 1 }, freeSlots: { $sum: { $subtract: [{ $ifNull: ["$batchCapacity", 1] }, { $ifNull: ["$batchLoad", 0] }] } } } }],
      riders: [{ $limit: 25 }, { $project: { name: 1, distance: 1, batchLoad: 1, batchCapacity: 1, batchAutoAssign: 1 } }] } }]).option({ maxTimeMS: 3000 });
  return { outlet: d.outletDto(outlet), orders: rows.slice(0, query.limit).map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, revision: o.revision })), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]._id) : null,
    couriers: counts[0]?.riders || [], eligiblePickupCouriers: counts[0]?.totals[0]?.couriers || 0, freeSlots: counts[0]?.totals[0]?.freeSlots || 0 };
}
module.exports = { stocked, recommendations, current, dashboard, run };
