const { HttpError } = require("@shared/utils/httpError");
const STATES = Object.freeze({ pending_dispatch: ["awaiting_rider", "cancelled"], awaiting_rider: ["offer_sent", "awaiting_manual_assignment", "cancelled"],
  awaiting_manual_assignment: ["offer_sent", "awaiting_rider", "cancelled"],
  offer_sent: ["assigned", "awaiting_rider", "awaiting_manual_assignment", "cancelled"], assigned: ["arrived_at_pickup", "awaiting_rider", "awaiting_manual_assignment", "exception", "cancelled"],
  arrived_at_pickup: ["picked_up", "awaiting_rider", "awaiting_manual_assignment", "exception", "cancelled"], picked_up: ["out_for_delivery", "exception"],
  out_for_delivery: ["delivered", "exception"], exception: ["delivered", "awaiting_manual_assignment", "cancelled"], delivered: [], cancelled: [] });
const enabled = () => process.env.COMMERCE_DELIVERY_ENABLED === "true";
const newEnabled = () => enabled() && process.env.COMMERCE_MANUAL_DISPATCH_ENABLED === "true";
function fail(message, status = 409) { throw new HttpError(status, message); }
function transition(from, to) { if (!STATES[from]?.includes(to)) fail("This delivery transition is not allowed."); }
function distance(a, b) {
  const rad = (v) => v * Math.PI / 180, dlat = rad(b.latitude - a.latitude), dlng = rad(b.longitude - a.longitude);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function eligible(courier, outletId, now, maxAge = 60, maxAccuracy = 100) {
  return courier?.active && courier.online && !courier.currentDeliveryId && !courier.currentTripId && courier.allowedOutletIds.some((id) => String(id) === String(outletId))
    && courier.location && Number.isFinite(courier.location.accuracy) && courier.location.accuracy >= 0 && courier.location.accuracy <= maxAccuracy && new Date(courier.location.receivedAt) <= now && now - new Date(courier.location.receivedAt) <= maxAge * 1000
    && now - new Date(courier.location.capturedAt) <= maxAge * 1000 && new Date(courier.location.capturedAt) <= now;
}
function paid(order) {
  if (order.paymentStatus !== "captured" || !["confirmed", "processing", "ready"].includes(order.status) || order.fulfillmentMethod !== "delivery")
    fail("A verified paid delivery order without unresolved payment issues is required.");
}
function editable(order, revision) {
  if (order.revision !== revision || order.paymentStatus !== "unpaid" || order.activeAttemptId || order.paidAttemptId || !["needs_details", "needs_review"].includes(order.status))
    fail("Order is locked or changed. Refresh before changing its restaurant.");
}
const dto = (record, fields) => record && Object.fromEntries([["id", String(record._id)], ...fields.map((key) => [key, record[key]])]);
const outletDto = (r) => dto(r, ["name", "address", "latitude", "longitude", "openingHours", "active", "prepMinutes", "radiusMetres", "revision"]);
const courierDto = (r) => dto(r, ["name", "phone", "vehicle", "active", "online", "allowedOutletIds", "location", "currentDeliveryId", "currentTripId", "address", "batchMode", "batchRadiusMetres", "pickupRadiusMetres", "batchLoad", "batchCapacity", "batchAutoAssign", "allowedZoneIds", "revision"]);
const deliveryDto = (r) => dto(r, ["orderId", "outletId", "tripId", "environment", "status", "pickedUpAt", "preparationStatus", "prepMinutes", "readyAt", "courierId", "offerExpiresAt", "autoDispatchPaused", "autoAttempts", "revision", "lastReason", "createdAt", "updatedAt"]);
module.exports = { STATES, enabled, newEnabled, fail, transition, distance, eligible, paid, editable, outletDto, courierDto, deliveryDto };
