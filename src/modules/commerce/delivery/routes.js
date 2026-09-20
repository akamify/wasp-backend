const express = require("express"), Joi = require("joi");
const { auth } = require("@core/middleware/auth");
const { requireWorkspace } = require("@core/middleware/requireWorkspace");
const { requireWorkspacePermission: permit } = require("@modules/workspaces/middleware/requireWorkspacePermission");
const { HttpError } = require("@shared/utils/httpError");
const limits = require("@core/middleware/rateLimiters");
const repo = require("./repository"), service = require("./service"), domain = require("./domain"), v = require("./validators");
const router = express.Router();
router.use((req, _res, next) => /^\/(outlets|couriers|deliveries|delivery-zones|delivery-trips|delivery-settings|delivery-notifications|delivery-tracking|rider)(\/|$)/.test(req.path)
  || /^\/orders\/[^/]+\/delivery(?:\/branches)?$/.test(req.path) ? next() : next("router"));
const safe = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch((e) => next(e instanceof HttpError ? e : new HttpError(e.code === 11000 ? 409 : 503, "Delivery operation could not complete. Refresh before retrying.")));
const id = (value) => v.parse(v.objectId.required(), value);
const revision = Joi.object({ revision: v.revision });
const page = (rows, query, map) => ({ items: rows.slice(0, query.limit).map(map), nextCursor: rows.length > query.limit ? String(rows[query.limit - 1]._id) : null });
router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next(); });
router.use(safe(async (_req, _res, next) => { await require("./readiness").ready(); next(); }));
router.get("/delivery-tracking", limits.ecommerceDeliveryRead, safe(async (req, res) => res.json({ tracking: await service.tracking(String(req.headers.authorization || "").replace(/^Bearer /, "")) })));
router.use(auth, limits.ecommerceDeliveryRead);
router.use((req, res, next) => ["POST", "PATCH", "PUT"].includes(req.method) ? limits.ecommerceDeliveryAction(req, res, next) : next());
router.use((req, _res, next) => ["POST", "PATCH", "PUT"].includes(req.method) && !req.is("application/json") ? next(new HttpError(415, "Use application/json.")) : next());
const rider = express.Router();
rider.use(safe(async (req, _res, next) => {
  const c = await repo.byUser(req.user.id);
  if (!c?.active || !await require("../repositories/orders.repository").workspaceActive(c.workspaceId)) domain.fail("Rider access unavailable.", 403);
  req.courier = c; next();
}));
rider.get("/me", safe(async (req, res) => {
  const c = req.courier, trip = c.currentTripId ? await service.required("Trip", c.workspaceId, c.currentTripId) : null;
  const tripRows = trip ? await repo.Delivery.find({ workspaceId: c.workspaceId, _id: { $in: trip.deliveryIds }, tripId: trip._id, courierId: c._id }).select("+pickupEnc +destinationEnc").lean() : [];
  const deliveries = trip ? trip.deliveryIds.map((id) => tripRows.find((r) => String(r._id) === String(id))).filter(Boolean).map((r) => ({ ...domain.deliveryDto(r), pickup: service.open(r, "pickupEnc"), destination: r.status === "offer_sent" ? null : service.open(r, "destinationEnc") })) : [];
  const current = c.currentDeliveryId ? await service.required("Delivery", c.workspaceId, c.currentDeliveryId) : null;
  const exposeDestination = current && !["pending_dispatch", "awaiting_rider", "awaiting_manual_assignment", "offer_sent", "cancelled", "delivered"].includes(current.status);
  res.json({ courier: domain.courierDto(c), trip: require("./batching").tripDto(trip), deliveries, delivery: current ? { ...domain.deliveryDto(current), pickup: service.open(current, "pickupEnc"), destination: exposeDestination ? service.open(current, "destinationEnc") : null } : null,
    gpsIntervalSeconds: Math.min(60, Math.max(10, Number(process.env.COMMERCE_RIDER_GPS_SECONDS) || 15)) });
}));
rider.post("/availability", safe(async (req, res) => {
  const input = v.parse(Joi.object({ online: Joi.boolean().required(), revision: v.revision }), req.body);
  if (req.courier.revision !== input.revision) domain.fail("Rider changed. Refresh.");
  res.json({ courier: domain.courierDto(await service.save("Courier", req.courier, { online: input.online })) });
}));
rider.post("/location", safe(async (req, res) => {
  const input = v.parse(v.gps, req.body), now = new Date();
  const config = await require("./routingSettings").get(req.courier.workspaceId);
  if (now - input.capturedAt > config.locationMaxAgeSeconds * 1000 || input.capturedAt > now || (req.courier.location && input.capturedAt <= new Date(req.courier.location.capturedAt))) domain.fail("Location is stale or out of order.");
  await service.save("Courier", req.courier, { location: { ...input, source: "gps", receivedAt: now }, geoPoint: { type: "Point", coordinates: [input.longitude, input.latitude] } }); res.json({ updated: true });
}));
rider.post("/deliveries/:id/action", safe(async (req, res) => res.json({ delivery: await service.action(req.courier.workspaceId, id(req.params.id), v.parse(v.action, req.body), req.user.id, true) })));
rider.post("/trips/:id/accept", safe(async (req, res) => res.json({ trip: await require("./batching").acceptTrip(req.courier.workspaceId, id(req.params.id), v.parse(revision, req.body).revision, req.user.id) })));
rider.get("/notifications", safe(async (req, res) => { const q = v.parse(v.page, req.query, true), rows = await repo.list("Notice", req.courier.workspaceId, { cursor: q.cursor, limit: q.limit, recipientId: req.user.id }); res.json(page(rows, q, (r) => ({ id: String(r._id), kind: r.kind, deliveryId: r.deliveryId, createdAt: r.createdAt }))); }));
router.use("/rider", rider);
router.use(requireWorkspace);
router.get("/delivery-zones", permit("commerce.delivery.view"), safe(async (req, res) => {
  const b = require("./batching"); if (!b.enabled()) { res.json({ enabled: false, items: [], nextCursor: null }); return; } await b.ready();
  const q = v.parse(v.page, req.query, true); res.json({ enabled: true, ...page(await repo.list("Zone", req.workspace.id, { limit: q.limit, cursor: q.cursor }), q, b.zoneDto) });
}));
router.post("/delivery-zones", permit("commerce.delivery.manage"), safe(async (req, res) => {
  const b = require("./batching"); await b.ready(); const input = v.parse(b.zoneSchema, req.body); await service.required("Outlet", req.workspace.id, input.outletId);
  res.status(201).json({ zone: b.zoneDto(await repo.create("Zone", { workspaceId: req.workspace.id, ...input })) });
}));
router.patch("/delivery-zones/:id", permit("commerce.delivery.manage"), safe(async (req, res) => {
  const b = require("./batching"); await b.ready(); const { revision, ...input } = v.parse(b.zoneSchema.keys({ revision: v.revision }), req.body), row = await service.required("Zone", req.workspace.id, id(req.params.id));
  if (row.revision !== revision || String(row.outletId) !== input.outletId) domain.fail("Zone changed. Its pickup outlet cannot be changed.");
  res.json({ zone: b.zoneDto(await service.save("Zone", row, input)) });
}));
router.patch("/couriers/:id/batching", permit("commerce.delivery.manage"), safe(async (req, res) => {
  const b = require("./batching"); await b.ready();
  const { revision, ...patch } = v.parse(Joi.object({ revision: v.revision, batchMode: Joi.string().valid("fixed_zone", "first_customer"), batchRadiusMetres: Joi.number().integer().min(100).max(50000), pickupRadiusMetres: Joi.number().integer().min(100).max(50000), batchCapacity: Joi.number().integer().min(1).max(30).required(), batchAutoAssign: Joi.boolean().required(), allowedZoneIds: Joi.array().items(v.objectId).max(100).unique().required() }), req.body);
  const c = await service.required("Courier", req.workspace.id, id(req.params.id)); if (c.revision !== revision) domain.fail("Courier changed.");
  if (c.currentTripId && patch.batchMode && patch.batchMode !== (c.batchMode || "fixed_zone")) domain.fail("Finish the active trip before changing its batch mode.");
  if (await repo.Zone.countDocuments({ workspaceId: req.workspace.id, _id: { $in: patch.allowedZoneIds }, outletId: { $in: c.allowedOutletIds } }) !== patch.allowedZoneIds.length) domain.fail("Select zones from this courier's allowed outlets.");
  res.json({ courier: domain.courierDto(await service.save("Courier", c, patch)) });
}));
router.post("/delivery-trips/assign", permit("commerce.delivery.manage"), safe(async (req, res) => res.json({ trip: await require("./batching").assign(req.workspace.id, req.body, req.user.id) })));
router.post("/delivery-trips/preview", permit("commerce.delivery.manage"), safe(async (req, res) => res.json(await require("./batching").assign(req.workspace.id, req.body, req.user.id, false, true))));
router.get("/delivery-trips", permit("commerce.delivery.view"), safe(async (req, res) => {
  const b = require("./batching"); await b.ready(); const q = v.parse(v.page, req.query, true);
  res.json(page(await repo.list("Trip", req.workspace.id, { limit: q.limit, cursor: q.cursor, environment: q.environment }), q, b.tripDto));
}));
router.get("/delivery-settings", permit("commerce.delivery.view"), safe(async (req, res) => {
  const settings = require("./routingSettings"), config = await settings.get(req.workspace.id);
  res.json({ ...config, mode: settings.autoEnabled() && config.autoDispatch && config.strategy !== "MANUAL" ? "automatic" : "manual",
    routingEnabled: settings.routingEnabled(), autoDispatchAvailable: settings.autoEnabled(), newDispatchEnabled: domain.newEnabled() });
}));
router.put("/delivery-settings", permit("commerce.delivery.manage"), safe(async (req, res) => res.json(await require("./routingSettings").save(req.workspace.id, req.body))));
router.post("/deliveries/:id/recommendations", permit("commerce.delivery.manage"), safe(async (req, res) => res.json(await require("./routing").recommend(req.workspace.id, id(req.params.id), v.parse(Joi.object({ revision: v.revision, mode: Joi.string().valid(...require("./routing").MODES).required() }), req.body)))));
router.get("/delivery-notifications", permit("commerce.delivery.view"), safe(async (req, res) => { const q = v.parse(v.page, req.query, true); res.json(page(await repo.list("Notice", req.workspace.id, { cursor: q.cursor, limit: q.limit, environment: q.environment, recipientId: null }), q, (r) => ({ id: String(r._id), kind: r.kind, orderId: r.orderId, deliveryId: r.deliveryId, reason: r.reason, createdAt: r.createdAt }))); }));
for (const [path, kind, dto] of [["outlets", "Outlet", domain.outletDto], ["couriers", "Courier", domain.courierDto], ["deliveries", "Delivery", domain.deliveryDto]]) {
  router.get(`/${path}`, permit("commerce.delivery.view"), safe(async (req, res) => {
    const q = v.parse(v.page, req.query, true), rows = await repo.list(kind, req.workspace.id, { cursor: q.cursor, limit: q.limit, ...(kind === "Delivery" ? { environment: q.environment } : {}) });
    if (kind !== "Delivery") { res.json(page(rows, q, dto)); return; }
    const records = await require("../models").CommerceOrder.find({ workspaceId: req.workspace.id, _id: { $in: rows.map((r) => r.orderId) } }).select("orderNumber paymentStatus").lean();
    const byId = new Map(records.map((r) => [String(r._id), r]));
    res.json(page(rows, q, (r) => ({ ...dto(r), pickup: service.open(r, "pickupEnc"), destination: service.open(r, "destinationEnc"), orderNumber: byId.get(String(r.orderId))?.orderNumber, paymentStatus: byId.get(String(r.orderId))?.paymentStatus })));
  }));
}
router.get("/deliveries/:id", permit("commerce.delivery.view"), safe(async (req, res) => { const r = await service.required("Delivery", req.workspace.id, id(req.params.id)); res.json({ delivery: { ...domain.deliveryDto(r), pickup: service.open(r, "pickupEnc"), destination: service.open(r, "destinationEnc") } }); }));
router.get("/orders/:id/delivery", permit("commerce.delivery.view"), safe(async (req, res) => res.json({ delivery: domain.deliveryDto(await repo.byOrder(req.workspace.id, id(req.params.id))), recommendation: await require("./branches").current(req.workspace.id, id(req.params.id)) })));
router.post("/outlets", permit("commerce.delivery.manage"), safe(async (req, res) => res.status(201).json({ outlet: domain.outletDto(await repo.create("Outlet", { workspaceId: req.workspace.id, ...v.parse(v.outlet, req.body) })) })));
router.patch("/outlets/:id", permit("commerce.delivery.manage"), safe(async (req, res) => { const input = v.parse(v.outlet.keys({ revision: v.revision }), req.body), r = await service.required("Outlet", req.workspace.id, id(req.params.id)); if (r.revision !== input.revision) domain.fail("Branch changed."); const { revision: _rev, ...patch } = input; res.json({ outlet: domain.outletDto(await service.save("Outlet", r, patch)) }); }));
router.post("/couriers", permit("commerce.delivery.manage"), safe(async (req, res) => {
  const { email, ...input } = v.parse(v.courier, req.body), ws = req.workspace.id;
  const account = await require("@infra/database/User").User.findOne({ email, status: "active", role: "user", accountBlocked: { $ne: true } }).select("_id").lean();
  if (!account) domain.fail("The rider must first register an active AIWizChat login.", 404);
  input.userId = account._id;
  if (await require("@infra/database/Workspace").Workspace.exists({ _id: ws, $or: [{ ownerId: input.userId }, { ownerUserId: input.userId }] })) domain.fail("Use a rider-only account, not the workspace owner.");
  if (await require("@infra/database/WorkspaceMember").WorkspaceMember.exists({ workspaceId: ws, userId: input.userId, status: "active" })) domain.fail("Use a rider-only account without merchant workspace membership.");
  if (await repo.Outlet.countDocuments({ workspaceId: ws, _id: { $in: input.allowedOutletIds }, active: true }) !== input.allowedOutletIds.length) domain.fail("Select active branches from this merchant.");
  res.status(201).json({ courier: domain.courierDto(await repo.create("Courier", { workspaceId: ws, ...input })) });
}));
router.patch("/couriers/:id", permit("commerce.delivery.manage"), safe(async (req, res) => {
  const input = v.parse(v.courier.fork("email", (s) => s.forbidden()).fork(["name", "phone", "vehicle"], (s) => s.optional()).keys({ revision: v.revision }), req.body);
  const r = await service.required("Courier", req.workspace.id, id(req.params.id));
  if (r.revision !== input.revision || r.currentDeliveryId || r.currentTripId) domain.fail("Refresh rider; resolve its current assignment before changing access.");
  if (await repo.Outlet.countDocuments({ workspaceId: req.workspace.id, _id: { $in: input.allowedOutletIds } }) !== input.allowedOutletIds.length) domain.fail("Invalid branches.");
  const { revision: _revision, ...patch } = input;
  res.json({ courier: domain.courierDto(await service.save("Courier", r, { ...patch, online: false })) });
}));
router.get("/outlets/:id/dispatch", permit("commerce.delivery.view"), permit("commerce.orders.view"), safe(async (req, res) => res.json(await require("./branches").dashboard(req.workspace.id, id(req.params.id), v.parse(v.page, req.query, true)))));
router.get("/outlets/:id/stock", permit("commerce.delivery.view"), safe(async (req, res) => { const q = v.parse(v.page, req.query, true); await service.required("Outlet", req.workspace.id, id(req.params.id)); res.json(page(await repo.list("Stock", req.workspace.id, { cursor: q.cursor, limit: q.limit, outletId: req.params.id }), q, (r) => ({ id: String(r._id), productId: r.productId, available: r.available, stockOnHand: r.stockOnHand, stockReserved: r.stockReserved, revision: r.revision }))); }));
router.post("/outlets/:id/stock/:productId/migrate", permit("commerce.delivery.manage"), permit("commerce.products.manage"), safe(async (req, res) => { const input = v.parse(revision.keys({ confirm: Joi.boolean().valid(true).required() }), req.body); res.json(await require("./inventory").migrate(req.workspace.id, id(req.params.productId), id(req.params.id), input.revision)); }));
router.put("/outlets/:id/stock/:productId", permit("commerce.delivery.manage"), permit("commerce.products.manage"), safe(async (req, res) => { const input = v.parse(Joi.object({ revision: Joi.number().integer().min(0).required(), stockOnHand: Joi.number().integer().min(0).max(1e8).required(), available: Joi.boolean().required() }), req.body); res.json(await require("./inventory").adjust(req.workspace.id, id(req.params.id), id(req.params.productId), input)); }));
router.post("/orders/:id/delivery/branches", permit("commerce.delivery.view"), permit("commerce.orders.manage"), safe(async (req, res) => res.json(await require("./branches").recommendations(req.workspace.id, id(req.params.id), v.parse(revision, req.body).revision))));
router.post("/orders/:id/delivery", permit("commerce.delivery.manage"), permit("commerce.orders.manage"), safe(async (req, res) => res.json({ delivery: await service.acceptOrder(req.workspace.id, id(req.params.id), v.parse(v.acceptance, req.body), req.user.id) })));
router.post("/deliveries/:id/offers", permit("commerce.delivery.manage"), safe(async (req, res) => res.json({ delivery: await service.offer(req.workspace.id, id(req.params.id), v.parse(v.offer, req.body), req.user.id) })));
router.post("/deliveries/:id/action", permit("commerce.delivery.manage"), safe(async (req, res) => res.json({ delivery: await service.action(req.workspace.id, id(req.params.id), v.parse(v.action, req.body), req.user.id, false, req.workspace.permissions.includes("commerce.delivery.override")) })));
router.post("/deliveries/:id/tracking", permit("commerce.delivery.manage"), safe(async (req, res) => res.json(await service.trackingLink(req.workspace.id, id(req.params.id), v.parse(revision, req.body).revision))));
module.exports = router;
