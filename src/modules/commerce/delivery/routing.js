const mongoose = require("mongoose");
const repo = require("./repository");
const service = require("./service");
const domain = require("./domain");
const settings = require("./routingSettings");
const google = require("./googleRoutes");
const orders = require("../repositories/orders.repository");
const operations = require("../repositories/operations.repository");
const MODES = ["nearest_pickup", "nearest_customer", "suggested", "smart"];
const point = (p) => ({ type: "Point", coordinates: [p.longitude, p.latitude] });
function pipeline(ws, delivery, pickup, customer, config, mode, now) {
  const cutoff = new Date(now.getTime() - config.locationMaxAgeSeconds * 1000);
  const query = { workspaceId: new mongoose.Types.ObjectId(String(ws)), allowedOutletIds: new mongoose.Types.ObjectId(String(delivery.outletId)),
    active: true, online: true, currentDeliveryId: null, currentTripId: null,
    vehicle: { $in: config.allowedVehicles || settings.smartDefaults.allowedVehicles },
    ...(delivery.autoExcludedIds?.length ? { _id: { $nin: delivery.autoExcludedIds.map((id) => new mongoose.Types.ObjectId(String(id))) } } : {}),
    "location.capturedAt": { $gte: cutoff, $lte: now }, "location.receivedAt": { $gte: cutoff, $lte: now },
    "location.accuracy": { $type: "number", $gte: 0, $lte: config.maxAccuracyMetres } };
  // Customer mode still enforces the pickup radius; it never selects another merchant/outlet.
  if (mode === "nearest_customer") query.geoPoint = { $geoWithin: { $centerSphere: [[pickup.longitude, pickup.latitude], config.pickupRadiusMetres / 6378100] } };
  return [{ $geoNear: { key: "geoPoint", near: point(mode === "nearest_customer" ? customer : pickup), spherical: true,
    distanceField: "shortlistDistanceMetres", ...(mode === "nearest_customer" ? {} : { maxDistance: config.pickupRadiusMetres }), query } },
  { $lookup: { from: repo.Delivery.collection.name, localField: "_id", foreignField: "activeCourierId", pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: "conflicts" } },
  { $match: { "conflicts.0": { $exists: false } } },
  { $limit: config.routeShortlist }, { $project: { _id: 1, name: 1, vehicle: 1, location: 1, active: 1, online: 1, currentDeliveryId: 1, allowedOutletIds: 1 } }];
}
function rank(rows, matrices, pickup, customer, mode, readyAt, now, handoverSeconds = settings.smartDefaults.handoverSeconds) {
  const result = [], waiting = Math.max(0, Math.ceil((new Date(readyAt || now) - now) / 1000));
  for (const [vehicle, group] of Object.entries(rows)) {
    const matrix = matrices[vehicle]; if (!matrix) continue;
    group.forEach((c, i) => {
      const toPickup = matrix.get(`${i}:0`), toCustomer = matrix.get(`${i}:1`), drop = matrix.get(`${group.length}:1`);
      if (!toPickup || (mode === "nearest_customer" && !toCustomer) || (["suggested", "smart"].includes(mode) && !drop)) return;
      const total = drop ? Math.max(toPickup.seconds, waiting) + handoverSeconds + drop.seconds : null;
      result.push({ courierId: String(c._id), name: c.name, vehicle, gpsAt: c.location.capturedAt, accuracyMetres: c.location.accuracy,
        pickupEtaSeconds: toPickup.seconds, pickupRoadMetres: toPickup.metres, customerDirectEtaSeconds: toCustomer?.seconds ?? null,
        deliveryEtaSeconds: total, pickupToCustomerSeconds: drop?.seconds ?? null,
        pickupStraightMetres: Math.round(domain.distance(c.location, pickup)), customerStraightMetres: Math.round(domain.distance(c.location, customer)),
        fallback: toPickup.fallback || Boolean(toCustomer?.fallback) || Boolean(drop?.fallback),
        scoreSeconds: mode === "nearest_pickup" ? toPickup.seconds : mode === "nearest_customer" ? toCustomer.seconds : total });
    });
  }
  return result.sort((a, b) => a.scoreSeconds - b.scoreSeconds || a.pickupEtaSeconds - b.pickupEtaSeconds || a.courierId.localeCompare(b.courierId));
}
async function recommend(ws, id, input, { automatic = false } = {}) {
  if (!MODES.includes(input.mode)) domain.fail("Unknown recommendation mode.", 400);
  await require("./readiness").routingReady();
  if (!process.env.COMMERCE_GOOGLE_ROUTES_API_KEY) domain.fail("Google Routes is not configured. Manual dispatch remains available.", 503);
  const r = await service.required("Delivery", ws, id);
  if (!["awaiting_rider", "awaiting_manual_assignment"].includes(r.status) || r.revision !== input.revision) domain.fail("Refresh this delivery before requesting recommendations.");
  const order = await orders.order(ws, r.orderId); if (!order) domain.fail("Order not found.", 404); domain.paid(order);
  if (await operations.hasPaymentIssue(ws, r.orderId)) domain.fail("Resolve payment issues before routing.");
  const config = await settings.get(ws), pickup = service.open(r, "pickupEnc"), customer = service.open(r, "destinationEnc")?.location;
  if (automatic && (!settings.autoEnabled() || !config.autoDispatch || config.strategy === "MANUAL" || r.autoDispatchPaused || r.status !== "awaiting_rider")) domain.fail("Automatic dispatch is paused.");
  if (automatic && input.mode !== { SMART: "smart", NEAREST_PICKUP: "nearest_pickup", NEAREST_CUSTOMER: "nearest_customer" }[config.strategy]) domain.fail("Dispatch strategy changed. Retry with current settings.");
  if (!google.validPoint(pickup) || !google.validPoint(customer)) domain.fail("Confirmed pickup and customer coordinates are required.");
  const now = new Date();
  // Durable cooldown limits duplicate billed requests across tabs and API processes.
  const claimed = await repo.Delivery.updateOne({ workspaceId: ws, _id: id, revision: input.revision, status: r.status,
    $or: [{ routingRequestedAt: null }, { routingRequestedAt: { $lte: new Date(now - 10000) } }] },
    { $set: { routingRequestedAt: now } }, { writeConcern: { w: "majority", j: true, wtimeout: 10000 } });
  if (claimed.modifiedCount !== 1) domain.fail("Wait ten seconds and refresh before requesting routes again.", 429);
  const shortlist = await repo.Courier.aggregate(pipeline(ws, { ...r, autoExcludedIds: automatic ? r.autoOfferedCourierIds : [] }, pickup, customer, config, input.mode, now)).option({ maxTimeMS: 3000 });
  const groups = {};
  for (const c of shortlist) (groups[c.vehicle] ||= []).push(c);
  const matrices = {}, failures = [];
  await Promise.all(Object.entries(groups).map(async ([vehicle, rows]) => {
    try { matrices[vehicle] = await google.matrix([...rows.map((c) => c.location), pickup], [pickup, customer], vehicle); }
    catch { failures.push(vehicle); }
  }));
  const finished = new Date(), current = await service.required("Delivery", ws, id);
  if (current.revision !== r.revision || current.status !== r.status) domain.fail("Delivery changed while routes were being calculated. Refresh.");
  // Re-read only the bounded shortlist: assignment, suspension or stale GPS may change during I/O.
  const fresh = shortlist.length ? await repo.Courier.find({ workspaceId: ws, _id: { $in: shortlist.map((c) => c._id) } }).lean() : [];
  const conflicts = shortlist.length ? await repo.Delivery.find({ activeCourierId: { $in: shortlist.map((c) => c._id) } }).select("activeCourierId").lean() : [];
  const candidates = rank(groups, matrices, pickup, customer, input.mode, r.readyAt, finished, config.handoverSeconds ?? settings.smartDefaults.handoverSeconds).filter((item) => {
    const c = fresh.find((c) => String(c._id) === item.courierId);
    return domain.eligible(c, r.outletId, finished, config.locationMaxAgeSeconds, config.maxAccuracyMetres)
      && (config.allowedVehicles || settings.smartDefaults.allowedVehicles).includes(c.vehicle) && c.vehicle === item.vehicle
      && !conflicts.some((other) => String(other.activeCourierId) === item.courierId)
      && domain.distance(c.location, pickup) <= config.pickupRadiusMetres && new Date(c.location.capturedAt).getTime() === new Date(item.gpsAt).getTime();
  });
  const expiresAt = new Date(Math.min(finished.getTime() + 15000, ...candidates.map((c) => new Date(c.gpsAt).getTime() + config.locationMaxAgeSeconds * 1000)));
  return { mode: input.mode, deliveryRevision: r.revision, generatedAt: finished, expiresAt, candidates,
    unavailableReason: !candidates.length ? (failures.length ? "routing_unavailable" : "no_eligible_rider") : null,
    settingsRevision: config.revision, suggestedCourierId: ["suggested", "smart"].includes(input.mode) ? candidates[0]?.courierId || null : null, shortlisted: shortlist.length,
    warning: failures.length || candidates.length < shortlist.length ? "Some routes or rider locations are unavailable. Results cover eligible riders with valid road estimates only." : "",
    provider: "Google Maps", confirmationRequired: true };
}
module.exports = { pipeline, rank, recommend, MODES, point };
