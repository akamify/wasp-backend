const crypto = require("node:crypto");
const mongoose = require("mongoose");
const repo = require("./repository");
const orders = require("../repositories/orders.repository");
const operations = require("../repositories/operations.repository");
const { encryptCommerceSecret, decryptCommerceSecret } = require("../services/commerceSecrets.service");
const d = require("./domain");
const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const pinDigest = (id, pin) => crypto.createHmac("sha256", Buffer.from(process.env.CREDENTIALS_ENCRYPTION_KEY || "", "base64")).update(`${id}:${pin}`).digest("hex");
const signature = (o) => digest(JSON.stringify([o.fulfillmentMethod, o.addressEnc, o.items.map((i) => [String(i.productId), i.quantity, i.unitPricePaise]), o.totalPaise]));
const seal = (r, field, value) => encryptCommerceSecret(JSON.stringify(value), { workspaceId: r.workspaceId, recordId: r._id, field });
const open = (r, field) => r[field] ? JSON.parse(decryptCommerceSecret(r[field], { workspaceId: r.workspaceId, recordId: r._id, field })) : null;
async function required(kind, ws, id, session) { const r = await repo.get(kind, ws, id, session); if (!r) d.fail("Record not found.", 404); return r; }
async function save(kind, r, patch, session) { const result = await repo.update(kind, r, patch, session); if (!result) d.fail("Record changed. Refresh and retry."); return result; }
async function order(ws, id, session) { const r = await orders.order(ws, id, session); if (!r) d.fail("Order not found.", 404); return r; }
async function fulfill(o, status, actor, session) {
  if (!await operations.transitionOrder(o, { status }, session)) d.fail("Order changed.");
  const attempt = o.paidAttemptId && await operations.attempt(o.workspaceId, o.paidAttemptId, session);
  if (attempt?.mode === "whatsapp_native") {
    const record = { _id: new mongoose.Types.ObjectId(), workspaceId: o.workspaceId, orderId: o._id, key: `native-status:${o._id}:${o.revision + 1}`, requestedBy: attempt.requestedBy };
    record.payloadEnc = seal(record, "payloadEnc", { amountPaise: o.totalPaise }); await operations.outbox(record, session);
  }
}
function isOpen(outlet, now = new Date()) {
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type) => local.find((p) => p.type === type).value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")), time = `${part("hour")}:${part("minute")}`;
  return outlet.openingHours.some((h) => h.day === day && h.open <= time && time < h.close);
}
async function acceptOrder(ws, id, input, userId) {
  if (!d.newEnabled()) d.fail("New manual delivery is disabled.", 503);
  if (input.selection === "nearest") {
    const result = await require("./branches").recommendations(ws, id, input.revision);
    if (!result.suggestedOutletId) d.fail("No eligible branch with stock and a road route. Select manually after review.");
    if (input.outletId && input.outletId !== result.suggestedOutletId) d.fail("Nearest branch changed. Refresh recommendations.");
    input = { ...input, outletId: result.suggestedOutletId };
  }
  return repo.transaction(async (session) => {
    const o = await order(ws, id, session); d.editable(o, input.revision);
    if (o.fulfillmentMethod !== "delivery") d.fail("Select delivery and confirm its destination first.");
    const destination = o.addressEnc && JSON.parse(decryptCommerceSecret(o.addressEnc, { workspaceId: ws, recordId: o._id, field: "addressEnc" }));
    if (!destination?.location?.confirmedAt) d.fail("Confirm the delivery map pin before accepting.");
    const outlet = await required("Outlet", ws, input.outletId, session);
    if (!outlet.active || !isOpen(outlet) || d.distance(outlet, destination.location) > outlet.radiusMetres) d.fail("Branch is closed, inactive or outside its service radius.");
    if (input.selection === "nearest") {
      const stocks = await repo.Stock.find({ workspaceId: ws, outletId: outlet._id, productId: { $in: o.items.map((i) => i.productId) } }).session(session).lean();
      if (!require("./branches").stocked(outlet._id, o.items, stocks)) d.fail("Branch inventory changed. Refresh branch selection.");
      for (const stock of stocks) await save("Stock", stock, {}, session);
      await save("Outlet", outlet, {}, session);
    }
    const existing = await repo.byOrder(ws, id, session);
    if (existing && !["pending_dispatch", "cancelled"].includes(existing.status)) d.fail("Delivery is already in progress.");
    const record = existing || { _id: new mongoose.Types.ObjectId(), workspaceId: ws, orderId: o._id, environment: o.environment };
    const patch = { status: "pending_dispatch", outletId: outlet._id, prepMinutes: input.prepMinutes, preparationStatus: "accepted", acceptedHash: signature(o),
      ...(existing?.status === "cancelled" ? { pinHash: "", pinEnc: "", trackingHash: "", trackingExpiresAt: null } : {}),
      pickupEnc: seal(record, "pickupEnc", { name: outlet.name, address: outlet.address, latitude: outlet.latitude, longitude: outlet.longitude }), destinationEnc: seal(record, "destinationEnc", destination) };
    const result = existing ? await save("Delivery", record, patch, session) : await repo.create("Delivery", { ...record, ...patch }, session);
    if (!await orders.updateOrder(ws, id, o.revision, { manualDeliveryId: result._id, recommendedOutletId: outlet._id, branchRoutingStatus: "suggested", branchRoutingToken: "", reviewedAt: null, reviewedBy: "" }, session)) d.fail("Order changed.");
    await repo.notice(result, "restaurant_accepted", userId, "", session);
    return d.deliveryDto(result);
  });
}
async function checkoutGuard(o, session) {
  const record = await repo.byOrder(o.workspaceId, o._id, session);
  if (!record || record.status !== "pending_dispatch" || record.preparationStatus !== "accepted" || record.acceptedHash !== signature(o))
    d.fail("Accept this delivery order and its current destination/quote at a branch before checkout.");
  const outlet = await required("Outlet", o.workspaceId, record.outletId, session);
  if (!outlet.active || !isOpen(outlet)) d.fail("The selected branch is not accepting orders.");
  const stocks = await repo.Stock.find({ workspaceId: o.workspaceId, outletId: record.outletId, productId: { $in: o.items.map((item) => item.productId) } }).session(session).lean();
  const byProduct = new Map(stocks.map((stock) => [String(stock.productId), stock]));
  for (const item of o.items) {
    const stock = byProduct.get(String(item.productId));
    if (!stock?.available || stock.stockOnHand - stock.stockReserved < item.quantity) d.fail("Configure sufficient branch inventory for every product before checkout.");
  }
  // Write fences serialize checkout with branch edits and restaurant acceptance.
  await save("Outlet", outlet, {}, session); await save("Delivery", record, {}, session);
  return record;
}
async function rejectPending(o, session, kind = "restaurant_rejected") {
  const r = await required("Delivery", o.workspaceId, o.manualDeliveryId, session);
  if (r.status === "cancelled") return;
  if (r.status !== "pending_dispatch") d.fail("Resolve active delivery before rejecting this order.");
  const saved = await save("Delivery", r, { status: "cancelled", preparationStatus: "rejected", pinHash: "", pinEnc: "", trackingHash: "", trackingExpiresAt: null }, session);
  await repo.notice(saved, kind, "", kind === "fulfillment_changed" ? "Unpaid order changed to pickup" : "Unpaid order cancelled by merchant", session);
}
async function dispatchFailure(record, reason, terminal = true) {
  return repo.transaction(async (session) => {
    const current = await required("Delivery", record.workspaceId, record._id, session);
    // A stale worker must never override manual takeover, a newer lease or an accepted offer.
    if (current.status !== "awaiting_rider" || current.autoDispatchPaused || current.autoAttempts !== record.autoAttempts
        || current.revision !== record.revision) return false;
    const saved = await save("Delivery", current, { ...(terminal ? { status: "awaiting_manual_assignment", autoDispatchPaused: true, autoNextAttemptAt: null } : {}), lastReason: reason }, session);
    await repo.notice(saved, terminal ? "awaiting_manual_assignment" : "auto_dispatch_retry", "system:auto-dispatch", reason, session);
    return true; // No order/payment mutation: merchant intervention never cancels a sale.
  });
}
async function retryState(record, session) {
  const settings = require("./routingSettings");
  if (!record.autoDispatchPaused && settings.autoEnabled()) {
    const config = await settings.get(record.workspaceId, session);
    if (config.autoDispatch && config.strategy !== "MANUAL") return "awaiting_rider";
  }
  return "awaiting_manual_assignment";
}
async function offer(ws, id, input, actor, automatic = null) {
  if (!d.newEnabled()) d.fail("New manual dispatch is disabled.", 503);
  return repo.transaction(async (session) => {
    const r = await required("Delivery", ws, id, session);
    if (r.offerKey === input.idempotencyKey) { if (String(r.courierId) !== input.courierId) d.fail("Offer key already used."); return d.deliveryDto(r); }
    if (r.tripId) d.fail("Use batch dispatch for trip orders.");
    if (r.revision !== input.revision || !(automatic ? ["awaiting_rider"] : ["awaiting_rider", "awaiting_manual_assignment"]).includes(r.status)) d.fail("Delivery is not awaiting an offer.");
    const o = await order(ws, r.orderId, session); d.paid(o);
    if (await operations.hasPaymentIssue(ws, o._id, session)) d.fail("Resolve payment/refund issues before dispatch.");
    if (!await operations.transitionOrder(o, {}, session)) d.fail("Order changed during dispatch.");
    const courier = await required("Courier", ws, input.courierId, session);
    const config = await require("./routingSettings").get(ws, session);
    if (automatic) {
      if (!require("./routingSettings").autoEnabled() || !config.autoDispatch || config.strategy === "MANUAL" || r.autoDispatchPaused
          || config.revision !== automatic.settingsRevision || new Date(automatic.expiresAt).getTime() <= Date.now()
          || (r.autoOfferedCourierIds || []).some((id) => String(id) === input.courierId)
          || new Date(courier.location?.capturedAt).getTime() !== new Date(automatic.gpsAt).getTime()
          || courier.vehicle !== automatic.vehicle) d.fail("Automatic recommendation changed or expired.");
      if (!await orders.workspaceActive(ws, session)) d.fail("Merchant is inactive.");
      // A write fence makes OFF/settings updates conflict with in-flight automatic offers.
      const fenced = await repo.RoutingSettings.updateOne({ workspaceId: ws, revision: config.revision, autoDispatch: true, strategy: { $ne: "MANUAL" } }, { $inc: { dispatchFence: 1 } }, { session });
      if (fenced.modifiedCount !== 1) d.fail("Automatic dispatch settings changed.");
      const outlet = await required("Outlet", ws, r.outletId, session);
      if (!outlet.active) d.fail("Outlet is inactive.");
      await save("Outlet", outlet, {}, session);
    }
    if (!d.eligible(courier, r.outletId, new Date(), config.locationMaxAgeSeconds, config.maxAccuracyMetres)) d.fail("Rider must be active, online, free, authorized and have recent accurate GPS.");
    if (!(config.allowedVehicles || require("./routingSettings").smartDefaults.allowedVehicles).includes(courier.vehicle)) d.fail("Rider vehicle is not allowed for this merchant.");
    if (await repo.Delivery.exists({ activeCourierId: courier._id }).session(session)) d.fail("Rider already has an active delivery or offer.");
    if (require("./routingSettings").routingEnabled() && d.distance(courier.location, open(r, "pickupEnc")) > Math.min(courier.pickupRadiusMetres || config.pickupRadiusMetres, config.pickupRadiusMetres)) d.fail("Rider is outside the configured pickup radius.");
    await save("Courier", courier, { currentDeliveryId: r._id }, session);
    const result = await save("Delivery", r, { status: "offer_sent", courierId: courier._id, activeCourierId: courier._id, offerKey: input.idempotencyKey, offerExpiresAt: new Date(Date.now() + config.offerSeconds * 1000),
      ...(automatic ? { autoOfferedCourierIds: [...(r.autoOfferedCourierIds || []), courier._id] } : { autoDispatchPaused: true }) }, session);
    if (automatic) await repo.notice(result, "auto_offer_sent", actor, "", session);
    await repo.notice(result, "delivery_offer", actor, "", session, courier.userId); await repo.notice(result, "offer_sent", actor, "", session);
    return d.deliveryDto(result);
  });
}
async function action(ws, id, input, actor, rider = false, override = false) {
  const result = await repo.transaction(async (session) => {
    const r = await required("Delivery", ws, id, session), o = await order(ws, r.orderId, session);
    if (r.revision !== input.revision) d.fail("Delivery changed. Refresh its status.");
    const courier = r.courierId ? await required("Courier", ws, r.courierId, session) : null;
    if (rider && (!courier?.active || String(courier.userId) !== String(actor))) d.fail("Delivery not found.", 404);
    const a = input.action;
    if (rider ? !["accept", "decline", "arrived_at_pickup", "picked_up", "out_for_delivery", "delivered", "exception"].includes(a)
      : !["prepare", "ready", "reassign", "cancel", "override", "exception", "pause_auto", "resume_auto"].includes(a)) d.fail("Action is not permitted.", 403);
    if (["reassign", "cancel", "override", "exception"].includes(a) && !input.reason) d.fail("A recorded reason is required.", 400);
    let patch = {}, release = false;
    if (["pause_auto", "resume_auto"].includes(a)) {
      if (!["awaiting_rider", "awaiting_manual_assignment", "offer_sent"].includes(r.status)) d.fail("Automatic dispatch controls require an unassigned delivery.");
      patch = { status: a === "pause_auto" ? "awaiting_manual_assignment" : r.status === "awaiting_manual_assignment" ? "awaiting_rider" : r.status, autoDispatchPaused: a === "pause_auto", ...(a === "resume_auto" ? { autoAttempts: 0, autoOfferedCourierIds: [], autoNextAttemptAt: null } : {}) };
      // Taking manual control also withdraws a pending offer and releases its rider.
      if (a === "pause_auto" && r.status === "offer_sent") { patch.status = "awaiting_manual_assignment"; release = true; }
    } else if (["prepare", "ready"].includes(a)) {
      d.paid(o); if (await operations.hasPaymentIssue(ws, o._id, session)) d.fail("Resolve payment issues first.");
      if (a === "prepare") { d.transition(r.status, "awaiting_rider"); await fulfill(o, "processing", actor, session); patch = { status: "awaiting_rider", preparationStatus: "preparing", readyAt: new Date(Date.now() + r.prepMinutes * 60000) }; }
      else { if (r.preparationStatus !== "preparing" || ["cancelled", "delivered", "exception"].includes(r.status)) d.fail("Preparation has not started."); patch = { preparationStatus: "ready", readyAt: new Date() }; }
    } else if (["accept", "decline"].includes(a)) {
      if (r.status !== "offer_sent" || new Date(r.offerExpiresAt).getTime() <= Date.now()) d.fail("Offer expired or already handled.");
      if (r.tripId) await require("./batching").membership(r, courier, session);
      else if (!courier || String(courier.currentDeliveryId) !== String(r._id) || String(r.activeCourierId) !== String(courier._id)) d.fail("Rider reservation changed. Refresh the offer.");
      if (a === "accept") {
        const config = await require("./routingSettings").get(ws, session);
        if (!d.eligible({ ...courier, currentDeliveryId: null, ...(r.tripId ? { currentTripId: null } : {}) }, r.outletId, new Date(), config.locationMaxAgeSeconds, config.maxAccuracyMetres)
            || !(config.allowedVehicles || require("./routingSettings").smartDefaults.allowedVehicles).includes(courier.vehicle)) d.fail("Refresh rider GPS and availability before accepting.");
        if (require("./routingSettings").routingEnabled() && d.distance(courier.location, open(r, "pickupEnc")) > Math.min(courier.pickupRadiusMetres || config.pickupRadiusMetres, config.pickupRadiusMetres)) d.fail("Rider is outside the configured pickup radius.");
        await save("Courier", courier, {}, session); // Serialize acceptance with GPS, suspension and competing reservations.
      }
      if (a === "accept") { d.paid(o); if (await operations.hasPaymentIssue(ws, o._id, session)) d.fail("Resolve payment issues first."); if (!await operations.transitionOrder(o, {}, session)) d.fail("Order changed."); }
      const next = a === "accept" ? "assigned" : await retryState(r, session);
      patch = { status: next, offerExpiresAt: null, ...(a === "decline" ? { autoNextAttemptAt: null, autoDispatchPaused: next === "awaiting_manual_assignment" } : {}) }; release = a === "decline";
    } else if (a === "reassign") { if (r.pickedUpAt) d.fail("Post-pickup custody cannot be reassigned."); if (r.status !== "exception") d.transition(r.status, "awaiting_rider"); patch.status = "awaiting_manual_assignment"; patch.autoDispatchPaused = true; release = true;
    } else if (a === "cancel") {
      if (["picked_up", "out_for_delivery"].includes(r.status) || (r.status === "exception" && r.pickedUpAt && !override)) d.fail("Resolve the custody exception with special permission before closing delivery.");
      d.transition(r.status, "cancelled"); patch.status = "cancelled"; release = true;
      if (r.pickedUpAt && !await operations.transitionOrder(o, { status: "requires_attention", attentionReason: "delivery_exception_closed" }, session)) d.fail("Order changed.");
    } else if (a === "delivered" || a === "override") {
      if (a === "override" && !override) d.fail("Delivery override permission required.", 403);
      if (!(a === "override" && r.status === "exception")) d.transition(r.status, "delivered");
      if (a !== "override") {
        if (!r.pinHash || !input.pin || (r.pinBlockedUntil && new Date(r.pinBlockedUntil).getTime() > Date.now())) d.fail("Delivery PIN unavailable or temporarily locked.", 429);
        const candidate = pinDigest(r._id, input.pin);
        if (!crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(r.pinHash))) {
          await save("Delivery", r, { pinFailures: r.pinFailures + 1, pinBlockedUntil: r.pinFailures >= 4 ? new Date(Date.now() + 15 * 60000) : null }, session);
          return { pinRejected: true }; // Commit the failed-attempt counter before reporting rejection.
        }
      }
      if (o.paymentStatus !== "captured" || o.status !== "out_for_delivery" || await operations.hasPaymentIssue(ws, o._id, session)) d.fail("Order needs merchant review before completion.");
      await fulfill(o, "completed", actor, session);
      patch = { status: "delivered", pinHash: "", pinEnc: "", trackingHash: "", trackingExpiresAt: null }; release = true;
    } else {
      d.transition(r.status, a); if (a === "picked_up" && r.preparationStatus !== "ready") d.fail("Restaurant must mark preparation ready before pickup.");
      if (["picked_up", "out_for_delivery"].includes(a)) {
        d.paid({ ...o, status: o.status === "out_for_delivery" ? "processing" : o.status });
        if (await operations.hasPaymentIssue(ws, o._id, session)) d.fail("Resolve payment issues before pickup.");
        if (r.tripId) await require("./batching")[a === "picked_up" ? "pickup" : "startDelivery"](r, courier, session);
        if (a === "picked_up") { await fulfill(o, "out_for_delivery", actor, session); patch.pickedUpAt = new Date(); }
      }
      patch.status = a;
    }
    if (release && r.tripId) await require("./batching").release(r, courier, session);
    if (release && courier && String(courier.currentDeliveryId) === String(r._id)) await save("Courier", courier, { currentDeliveryId: null }, session);
    const saved = await save("Delivery", r, { ...patch, ...(release ? { activeCourierId: null, offerExpiresAt: null, tripId: null } : {}), lastReason: input.reason || "" }, session);
    await repo.notice(saved, a, actor, input.reason, session);
    if (saved.status === "awaiting_manual_assignment") await repo.notice(saved, "awaiting_manual_assignment", actor, input.reason || "Manual rider assignment is required.", session);
    if (courier) await repo.notice(saved, a, actor, input.reason, session, courier.userId);
    return d.deliveryDto(saved);
  });
  if (result.pinRejected) d.fail("Incorrect delivery PIN. Refresh before retrying.", 400);
  return result;
}
async function expireOffers() {
  const rows = await repo.Delivery.find({ status: "offer_sent", offerExpiresAt: { $lte: new Date() } }).sort({ offerExpiresAt: 1 }).limit(50).lean();
  let expired = 0, failed = 0;
  for (const r of rows) try { await repo.transaction(async (session) => {
    const current = await required("Delivery", r.workspaceId, r._id, session);
    if (current.status !== "offer_sent" || new Date(current.offerExpiresAt) > new Date()) return;
    const c = await repo.get("Courier", r.workspaceId, current.courierId, session);
    if (current.tripId) await require("./batching").release(current, c, session);
    if (c && String(c.currentDeliveryId) === String(current._id)) await save("Courier", c, { currentDeliveryId: null }, session);
    const manual = !c || await retryState(current, session) === "awaiting_manual_assignment";
    const saved = await save("Delivery", current, { status: manual ? "awaiting_manual_assignment" : "awaiting_rider", autoDispatchPaused: Boolean(manual), activeCourierId: null, tripId: null, offerExpiresAt: null, autoNextAttemptAt: null }, session);
    await repo.notice(saved, "offer_expired", "", "", session);
    if (c) await repo.notice(saved, "offer_expired", "", "", session, c.userId);
    if (manual) await repo.notice(saved, "awaiting_manual_assignment", "system:delivery-recovery", "Offer expired. Manual rider assignment is required.", session);
    return true;
  }).then((changed) => { if (changed) expired++; }); } catch { failed++; }
  if (failed) require("@core/logger/logger").warn("Delivery expiry recovery needs attention", { event: "delivery_expiry_retry", failed });
  return { expired, failed };
}
async function trackingLink(ws, id, revision) {
  return repo.transaction(async (session) => {
    const r = await required("Delivery", ws, id, session);
    if (r.revision !== revision || ["delivered", "cancelled"].includes(r.status)) d.fail("Delivery is closed or changed.");
    const token = crypto.randomBytes(32).toString("hex"), pin = crypto.randomInt(100000, 1000000).toString();
    await save("Delivery", r, { trackingHash: digest(token), trackingExpiresAt: new Date(Date.now() + 86400000), pinHash: pinDigest(r._id, pin), pinEnc: seal(r, "pinEnc", pin), pinFailures: 0, pinBlockedUntil: null }, session);
    return { token }; // The PIN is available only through the customer's bearer session.
  });
}
async function tracking(token) {
  if (!/^[a-f0-9]{64}$/.test(token || "")) d.fail("Invalid tracking session.", 401);
  const r = await repo.Delivery.findOne({ trackingHash: digest(token), trackingExpiresAt: { $gt: new Date() }, status: { $nin: ["delivered", "cancelled"] } }).select("+pinEnc").lean();
  if (!r) d.fail("Tracking link expired or delivery closed.", 410);
  return { status: r.status, preparationStatus: r.preparationStatus, readyAt: r.readyAt, pin: open(r, "pinEnc") };
}
module.exports = { required, save, acceptOrder, checkoutGuard, rejectPending, dispatchFailure, offer, action, expireOffers, trackingLink, tracking, open, seal, signature, isOpen, pinDigest };
