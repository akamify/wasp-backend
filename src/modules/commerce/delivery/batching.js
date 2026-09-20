const mongoose = require("mongoose");
const Joi = require("joi");
const repo = require("./repository"), service = require("./service"), d = require("./domain"), v = require("./validators");
const settings = require("./routingSettings"), orders = require("../repositories/orders.repository"), operations = require("../repositories/operations.repository");
const google = require("./googleRoutes");
const { HttpError } = require("@shared/utils/httpError");
const changed = (message) => { throw Object.assign(new HttpError(409, message), { batchRetryable: true }); };
const enabled = () => settings.routingEnabled() && process.env.COMMERCE_BATCHING_ENABLED === "true";
const waiting = ["awaiting_rider", "awaiting_manual_assignment"];
const zoneSchema = Joi.object({ name: Joi.string().trim().min(1).max(150).required(), outletId: v.objectId.required(), latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(),
  radiusMetres: Joi.number().integer().min(100).max(50000).required(), active: Joi.boolean().required(), autoAssign: Joi.boolean().required(), priority: Joi.number().integer().min(0).max(100).required(),
  prepToleranceSeconds: Joi.number().integer().min(0).max(1800).required(), maxWaitSeconds: Joi.number().integer().min(0).max(1800).required(),
  maxTripSeconds: Joi.number().integer().min(300).max(7200).required(), maxDetourSeconds: Joi.number().integer().min(0).max(3600).required(), stopSeconds: Joi.number().integer().min(0).max(600).required() });
const assignSchema = Joi.object({ courierId: v.objectId.required(), zoneId: v.objectId, idempotencyKey: Joi.string().guid({ version: "uuidv4" }).required(),
  deliveries: Joi.array().min(1).max(30).unique("id").items(Joi.object({ id: v.objectId.required(), revision: v.revision })).required() });
const zoneDto = (r) => ({ id: String(r._id), ...Object.fromEntries(["name", "outletId", "latitude", "longitude", "radiusMetres", "active", "autoAssign", "priority", "prepToleranceSeconds", "maxWaitSeconds", "maxTripSeconds", "maxDetourSeconds", "stopSeconds", "revision"].map((key) => [key, r[key]])) });
const tripDto = (r) => r && ({ id: String(r._id), outletId: r.outletId, zoneId: r.zoneId, batchCentre: r.batchCentre, courierId: r.courierId, status: r.status, deliveryIds: r.deliveryIds, revision: r.revision, latestDepartureAt: r.latestDepartureAt });
async function ready() {
  if (!enabled()) d.fail("Batch dispatch is not enabled.", 503);
  await require("./readiness").routingReady();
  const { getIndexPlan, checkIndexes } = require("../models/indexPlan");
  if ((await checkIndexes(mongoose.connection.db, getIndexPlan({ Zone: repo.Zone, Trip: repo.Trip }))).length) d.fail("Prepare batch delivery indexes first.", 503);
}
function eligible(c, outletId, config, now = new Date()) {
  return d.eligible({ ...c, currentTripId: null }, outletId, now, config.locationMaxAgeSeconds, config.maxAccuracyMetres)
    && (config.allowedVehicles || settings.smartDefaults.allowedVehicles).includes(c.vehicle);
}
function compatible(records, zone, c, trip, now = new Date()) {
  if (!zone.active || records.length > (c.batchCapacity || 1) || records.length > 30) d.fail("Zone inactive or courier capacity exceeded.");
  if (!zone.dynamic && !(c.allowedZoneIds || []).some((id) => String(id) === String(zone._id))) d.fail("Courier is not enabled for this zone.");
  if (trip && (trip.status !== "loading" || String(trip.zoneId) !== String(zone._id))) d.fail("Trip has departed or belongs to another zone.");
  const first = records[0], times = [], pickup = service.open(first, "pickupEnc");
  for (const r of records) {
    if (![...waiting, "offer_sent", "assigned", "arrived_at_pickup"].includes(r.status)) d.fail("Resolve delivery exceptions before adding trip orders.");
    if (String(r.workspaceId) !== String(zone.workspaceId) || String(r.outletId) !== String(zone.outletId) || r.environment !== first.environment) d.fail("A trip requires the same merchant, pickup outlet and environment.");
    const origin = service.open(r, "pickupEnc");
    if (!google.validPoint(origin) || origin.latitude !== pickup?.latitude || origin.longitude !== pickup?.longitude) d.fail("Pickup coordinates changed between these orders. Review the outlet.");
    if (!["preparing", "ready"].includes(r.preparationStatus) || !r.readyAt || !Number.isFinite(new Date(r.readyAt).getTime())) d.fail("Every order needs a preparation ready time.");
    const destination = service.open(r, "destinationEnc")?.location;
    if (!google.validPoint(destination) || d.distance(destination, zone) > zone.radiusMetres) d.fail("An order is outside the delivery zone.");
    times.push(Math.max(now.getTime(), new Date(r.readyAt).getTime()));
  }
  if (Math.max(...times) - Math.min(...times) > zone.prepToleranceSeconds * 1000) d.fail("Order preparation times are not compatible.");
  const latestDepartureAt = trip?.latestDepartureAt || new Date(Math.min(...times) + zone.maxWaitSeconds * 1000);
  if (Math.max(...times) > new Date(latestDepartureAt).getTime()) d.fail("Adding orders would exceed the trip's pickup wait limit.");
  return latestDepartureAt;
}
// Preserve accepted stop order. Append only when every stop remains within the
// merchant's configured road detour and total route limits. Google content is not persisted.
async function routeCheck(records, pickup, vehicle, zone) {
  const points = records.map((r) => service.open(r, "destinationEnc").location), table = new Map();
  for (let base = 0; base < points.length; base += 4) await Promise.all([base, base + 2].filter((offset) => offset < points.length).map(async (offset) => {
    const origins = [pickup, ...points.slice(Math.max(0, offset - 1), offset + 1)];
    const matrix = await google.matrix(origins, points.slice(offset, offset + 2), vehicle);
    for (let j = 0; j < Math.min(2, points.length - offset); j++) {
      const index = offset + j;
      table.set(`direct:${index}`, matrix.get(`0:${j}`));
      table.set(`leg:${index}`, matrix.get(`${index === 0 ? 0 : index - Math.max(0, offset - 1)}:${j}`));
    }
  }));
  let elapsed = 0;
  for (let i = 0; i < records.length; i++) {
    const leg = table.get(`leg:${i}`), direct = table.get(`direct:${i}`);
    if (!leg || !direct) d.fail("A batch road route is unavailable.", 503);
    elapsed += leg.seconds;
    if (elapsed > zone.maxTripSeconds || elapsed > direct.seconds + zone.maxDetourSeconds) d.fail("Batch exceeds the configured delivery time or detour limit.");
    elapsed += zone.stopSeconds;
    if (elapsed > zone.maxTripSeconds) d.fail("Batch exceeds the configured trip duration including stops.");
  }
  return { routeSeconds: elapsed, stops: records.length };
}
function dynamicZone(c, first, trip) {
  if (c.batchMode !== "first_customer" || trip?.zoneId) d.fail("Select a fixed zone for this courier/trip.");
  const centre = trip?.batchCentre || service.open(first, "destinationEnc")?.location;
  if (!google.validPoint(centre)) d.fail("Confirmed first customer location required.");
  return { _id: null, dynamic: true, workspaceId: first.workspaceId, outletId: first.outletId, ...centre,
    radiusMetres: Math.min(centre.radiusMetres || c.batchRadiusMetres || 4000, c.batchRadiusMetres || 4000),
    active: true, autoAssign: c.batchAutoAssign, prepToleranceSeconds: 300, maxWaitSeconds: 300,
    maxTripSeconds: 7200, maxDetourSeconds: 1800, stopSeconds: 120 };
}
const pickupLimit = (c, config) => Math.min(c.pickupRadiusMetres || config.pickupRadiusMetres, config.pickupRadiusMetres);
async function assign(ws, raw, actor, automatic = false, preview = false) {
  const input = v.parse(assignSchema, raw); await ready();
  if (!d.newEnabled()) d.fail("New dispatch is paused.", 503);
  const c = await service.required("Courier", ws, input.courierId), config = await settings.get(ws);
  const selected = await Promise.all(input.deliveries.map((r) => service.required("Delivery", ws, r.id)));
  if (selected.every((r) => r.offerKey === input.idempotencyKey && String(r.courierId) === input.courierId && r.tripId)) return tripDto(await service.required("Trip", ws, selected[0].tripId));
  const trip = c.currentTripId ? await service.required("Trip", ws, c.currentTripId) : null;
  const zone = input.zoneId ? await service.required("Zone", ws, input.zoneId) : dynamicZone(c, selected[0], trip);
  if (input.zoneId && c.batchMode === "first_customer") d.fail("Use the first-customer radius option for this courier.");
  if (!eligible(c, zone.outletId, config)) d.fail("Courier needs recent GPS and must be active, online and free of a single-order delivery.");
  if (automatic && (!settings.autoEnabled() || !config.autoDispatch || config.strategy === "MANUAL" || !zone.autoAssign || !c.batchAutoAssign)) d.fail("Automatic batch assignment is paused.");
  const existing = trip ? await Promise.all(trip.deliveryIds.map((id) => service.required("Delivery", ws, id))) : [];
  if (existing.length !== (c.batchLoad || 0)) d.fail("Courier trip capacity needs reconciliation.");
  for (const [i, r] of selected.entries()) if (!waiting.includes(r.status) || r.tripId || r.revision !== input.deliveries[i].revision || automatic && r.autoDispatchPaused) d.fail("An order changed or is already reserved.");
  const records = [...existing, ...selected], departure = compatible(records, zone, c, trip), pickup = service.open(selected[0], "pickupEnc");
  if (!google.validPoint(pickup) || d.distance(c.location, pickup) > pickupLimit(c, config)) d.fail("Courier is outside the pickup radius.");
  for (const r of selected) { const o = await orders.order(ws, r.orderId); if (!o) d.fail("Order missing."); d.paid(o); if (await operations.hasPaymentIssue(ws, r.orderId)) d.fail("Resolve payment issues before batching."); }
  const route = await routeCheck(records, pickup, c.vehicle, zone);
  if (preview) return { ...route, capacity: c.batchCapacity || 1, totalOrders: records.length, latestDepartureAt: departure, provider: "Google Maps" };
  return repo.transaction(async (session) => {
    const current = await service.required("Courier", ws, c._id, session), currentZone = zone.dynamic ? dynamicZone(current, selected[0], trip) : await service.required("Zone", ws, zone._id, session), currentConfig = await settings.get(ws, session);
    // Foreground GPS increments the courier revision frequently. Revalidate its
    // current location and reservation/configuration instead of rejecting GPS-only updates.
    if (String(current.currentTripId || "") !== String(c.currentTripId || "") || (current.batchLoad || 0) !== (c.batchLoad || 0)
        || current.vehicle !== c.vehicle || current.batchMode !== c.batchMode || current.batchRadiusMetres !== c.batchRadiusMetres || currentZone.revision !== zone.revision || currentConfig.revision !== config.revision
        || !eligible(current, zone.outletId, currentConfig) || d.distance(current.location, pickup) > pickupLimit(current, currentConfig)) changed("Courier, GPS or settings changed. Refresh and retry.");
    if (!await orders.workspaceActive(ws, session)) d.fail("Merchant is inactive.");
    if (await repo.Delivery.exists({ activeCourierId: current._id }).session(session)) d.fail("Courier already has a single-order reservation.");
    if (automatic && (!settings.autoEnabled() || !currentConfig.autoDispatch || !currentZone.autoAssign || !current.batchAutoAssign)) d.fail("Automatic assignment is paused.");
    const outlet = await service.required("Outlet", ws, zone.outletId, session); if (!outlet.active) d.fail("Pickup outlet is inactive.");
    await service.save("Outlet", outlet, {}, session);
    if (!zone.dynamic) { const zoneFence = await repo.Zone.updateOne({ workspaceId: ws, _id: zone._id, revision: zone.revision }, { $inc: { dispatchFence: 1 } }, { session });
    if (zoneFence.modifiedCount !== 1) changed("Delivery zone changed."); }
    if (automatic) {
      const fenced = await repo.RoutingSettings.updateOne({ workspaceId: ws, revision: config.revision, autoDispatch: true, strategy: { $ne: "MANUAL" } }, { $inc: { dispatchFence: 1 } }, { session });
      if (fenced.modifiedCount !== 1) changed("Dispatch settings changed.");
    }
    for (const old of records) {
      const r = await service.required("Delivery", ws, old._id, session); if (r.revision !== old.revision) d.fail("Trip orders changed.");
      const o = await orders.order(ws, r.orderId, session); if (!o) d.fail("Order missing."); d.paid(o);
      if (await operations.hasPaymentIssue(ws, r.orderId, session) || !await operations.transitionOrder(o, {}, session)) d.fail("Order payment needs review.");
    }
    compatible(records, currentZone, current, trip, new Date());
    let savedTrip;
    if (trip) { const live = await service.required("Trip", ws, trip._id, session); if (live.revision !== trip.revision || live.status !== "loading") changed("Trip changed."); savedTrip = await service.save("Trip", live, { deliveryIds: records.map((r) => r._id) }, session); }
    else savedTrip = await repo.create("Trip", { workspaceId: ws, outletId: zone.outletId, zoneId: zone._id, ...(zone.dynamic ? { batchCentre: { latitude: zone.latitude, longitude: zone.longitude, radiusMetres: zone.radiusMetres } } : {}), courierId: c._id, activeCourierId: c._id, environment: selected[0].environment, deliveryIds: records.map((r) => r._id), latestDepartureAt: departure }, session);
    await service.save("Courier", current, { currentTripId: savedTrip._id, batchLoad: records.length }, session);
    for (const r of selected) {
      const saved = await service.save("Delivery", r, { tripId: savedTrip._id, courierId: c._id, activeCourierId: null, status: "offer_sent", offerKey: input.idempotencyKey,
        offerExpiresAt: new Date(Date.now() + config.offerSeconds * 1000), autoDispatchPaused: !automatic,
        ...(automatic ? { autoOfferedCourierIds: [...(r.autoOfferedCourierIds || []), c._id] } : {}) }, session);
      await repo.notice(saved, "batch_offer", actor, "Rider acceptance is required for this order.", session);
      await repo.notice(saved, "batch_offer", actor, "", session, c.userId);
    }
    return tripDto(savedTrip);
  });
}
async function membership(r, c, session) {
  const trip = await service.required("Trip", r.workspaceId, r.tripId, session);
  if (!c || String(c.currentTripId) !== String(trip._id) || String(trip.courierId) !== String(c._id) || !trip.deliveryIds.some((id) => String(id) === String(r._id))) d.fail("Trip reservation changed.");
  return trip;
}
async function release(r, c, session) {
  const trip = await membership(r, c, session), ids = trip.deliveryIds.filter((id) => String(id) !== String(r._id));
  await service.save("Trip", trip, { deliveryIds: ids, ...(!ids.length ? { status: "completed", activeCourierId: null } : {}) }, session);
  await service.save("Courier", c, { batchLoad: ids.length, ...(!ids.length ? { currentTripId: null } : {}) }, session);
}
async function pickup(r, c, session) {
  const trip = await membership(r, c, session);
  const rows = await repo.Delivery.find({ workspaceId: r.workspaceId, _id: { $in: trip.deliveryIds } }).session(session).lean();
  if (rows.length !== trip.deliveryIds.length || rows.some((row) => !["arrived_at_pickup", "picked_up", "out_for_delivery"].includes(row.status) || row.preparationStatus !== "ready")) d.fail("Accept every trip order and mark arrival; all food must be ready before departure.");
  await service.save("Trip", trip, { status: "departed" }, session);
}
async function acceptTrip(ws, id, revision, userId) {
  return repo.transaction(async (session) => {
    const trip = await service.required("Trip", ws, id, session), c = await service.required("Courier", ws, trip.courierId, session), config = await settings.get(ws, session);
    if (trip.revision !== revision || trip.status !== "loading" || String(c.userId) !== String(userId) || String(c.currentTripId) !== String(id)) d.fail("Trip changed or rider is not authorized.");
    if (!eligible(c, trip.outletId, config)) d.fail("Refresh GPS and rider availability before accepting.");
    let accepted = 0;
    for (const deliveryId of trip.deliveryIds) {
      const r = await service.required("Delivery", ws, deliveryId, session);
      await membership(r, c, session);
      if (r.status !== "offer_sent") continue;
      if (new Date(r.offerExpiresAt).getTime() <= Date.now() || d.distance(c.location, service.open(r, "pickupEnc")) > pickupLimit(c, config)) d.fail("An offer expired or rider moved outside the pickup radius.");
      const o = await orders.order(ws, r.orderId, session); if (!o) d.fail("Order missing."); d.paid(o);
      if (await operations.hasPaymentIssue(ws, r.orderId, session) || !await operations.transitionOrder(o, {}, session)) d.fail("Order payment needs review.");
      const saved = await service.save("Delivery", r, { status: "assigned", offerExpiresAt: null }, session);
      await repo.notice(saved, "accept", userId, "Trip offers accepted", session); await repo.notice(saved, "accept", userId, "", session, c.userId); accepted++;
    }
    if (!accepted) return tripDto(trip);
    await service.save("Courier", c, {}, session);
    return tripDto(await service.save("Trip", trip, {}, session));
  });
}
async function startDelivery(r, c, session) {
  const trip = await membership(r, c, session);
  if (String(trip.deliveryIds[0]) !== String(r._id)) d.fail("Follow the trip stop sequence.");
  const rows = await repo.Delivery.find({ workspaceId: r.workspaceId, _id: { $in: trip.deliveryIds } }).session(session).lean();
  if (rows.length !== trip.deliveryIds.length || rows.some((row) => !["picked_up", "out_for_delivery"].includes(row.status))) d.fail("Collect all trip orders before starting delivery.");
  await service.save("Trip", trip, {}, session);
}
async function automatic(r) {
  await ready();
  const destination = service.open(r, "destinationEnc")?.location;
  if (!google.validPoint(destination)) d.fail("Confirmed customer coordinates required.");
  const zones = await repo.Zone.find({ workspaceId: r.workspaceId, outletId: r.outletId, active: true }).sort({ priority: 1, _id: 1 }).limit(101).lean();
  if (zones.length > 100) d.fail("Too many delivery zones for this outlet.");
  const zone = zones.find((z) => d.distance(destination, z) <= z.radiusMetres);
  const fixedZone = zone?.autoAssign ? zone : null;
  const config = await settings.get(r.workspaceId), pickup = service.open(r, "pickupEnc"), now = new Date(), cutoff = new Date(now - config.locationMaxAgeSeconds * 1000);
  if (!google.validPoint(pickup)) d.fail("Confirmed pickup coordinates required.");
  const candidates = await repo.Courier.aggregate([{ $geoNear: { key: "geoPoint", near: { type: "Point", coordinates: [pickup.longitude, pickup.latitude] }, spherical: true, maxDistance: config.pickupRadiusMetres, distanceField: "distance",
    query: { workspaceId: new mongoose.Types.ObjectId(String(r.workspaceId)), allowedOutletIds: r.outletId, $or: [{ batchMode: "first_customer" }, ...(fixedZone ? [{ batchMode: { $ne: "first_customer" }, allowedZoneIds: fixedZone._id }] : [])], active: true, online: true, batchAutoAssign: true, currentDeliveryId: null,
      _id: { $nin: r.autoOfferedCourierIds || [] }, vehicle: { $in: config.allowedVehicles }, "location.capturedAt": { $gte: cutoff, $lte: now }, "location.receivedAt": { $gte: cutoff, $lte: now }, "location.accuracy": { $gte: 0, $lte: config.maxAccuracyMetres }, $expr: { $lt: [{ $ifNull: ["$batchLoad", 0] }, { $ifNull: ["$batchCapacity", 1] }] } } } },
    { $lookup: { from: repo.Trip.collection.name, localField: "currentTripId", foreignField: "_id", as: "trip" } },
    { $match: { $expr: { $lte: ["$distance", { $ifNull: ["$pickupRadiusMetres", config.pickupRadiusMetres] }] }, $or: [{ currentTripId: null }, { "trip.0.status": "loading", "trip.0.zoneId": { $in: [null, ...(fixedZone ? [fixedZone._id] : [])] }, "trip.0.outletId": r.outletId, "trip.0.environment": r.environment }] } },
    { $limit: config.routeShortlist }]).option({ maxTimeMS: 3000 });
  // Consolidate compatible loading trips first, then rank the bounded shortlist
  // using the merchant's configured road-ETA strategy.
  const groups = {}, matrices = {};
  for (const c of candidates) (groups[c.vehicle] ||= []).push(c);
  await Promise.all(Object.entries(groups).map(async ([vehicle, rows]) => { matrices[vehicle] = await google.matrix([...rows.map((c) => c.location), pickup], [pickup, destination], vehicle); }));
  const mode = config.batchPriority === "nearest_pickup" ? "nearest_pickup" : config.strategy === "NEAREST_CUSTOMER" ? "nearest_customer" : config.strategy === "NEAREST_PICKUP" ? "nearest_pickup" : "smart";
  const ranked = require("./routing").rank(groups, matrices, pickup, destination, mode, r.readyAt, now, config.handoverSeconds);
  if (config.batchPriority === "existing_batch") ranked.sort((a, b) => Number(Boolean(candidates.find((c) => String(c._id) === b.courierId)?.currentTripId)) - Number(Boolean(candidates.find((c) => String(c._id) === a.courierId)?.currentTripId)) || a.scoreSeconds - b.scoreSeconds);
  let conflict;
  for (const c of ranked) {
    const candidate = candidates.find((row) => String(row._id) === c.courierId);
    if (candidate.batchMode !== "first_customer" && !fixedZone) continue;
    const input = { courierId: c.courierId, ...(candidate.batchMode === "first_customer" ? {} : { zoneId: String(fixedZone._id) }), deliveries: [{ id: String(r._id), revision: r.revision }], idempotencyKey: require("node:crypto").randomUUID() };
    for (let attempt = 0; attempt < 2; attempt++) try { await assign(r.workspaceId, input, "system:auto-dispatch", true); return "offered"; }
    catch (e) { if (e.statusCode === 503) throw e; if (e.batchRetryable) { conflict = e; continue; } break; }
  }
  if (conflict) throw conflict;
  return await service.dispatchFailure(r, "No courier has compatible trip capacity. Assign manually.") ? "awaiting_manual_assignment" : "superseded";
}
module.exports = { enabled, ready, dynamicZone, pickupLimit, zoneSchema, assignSchema, zoneDto, tripDto, compatible, routeCheck, assign, acceptTrip, membership, release, pickup, startDelivery, automatic };
