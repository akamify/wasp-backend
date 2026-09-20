const { define, mongoose, ref, count, secret } = require("../models/schema");
const { STATES } = require("./domain");
const text = (max = 200) => ({ type: String, maxlength: max, default: "" });
const location = new mongoose.Schema({ latitude: { type: Number, min: -90, max: 90, required: true }, longitude: { type: Number, min: -180, max: 180, required: true },
  accuracy: { type: Number, min: 0, max: 100000, default: null }, source: { type: String, enum: ["gps", "map", "manual"] }, capturedAt: Date, receivedAt: Date, confirmedAt: Date }, { _id: false, strict: "throw" });
const Outlet = define("CommerceOutlet", { name: { ...text(150), required: true }, address: { ...text(1000), required: true },
  latitude: { type: Number, min: -90, max: 90, required: true }, longitude: { type: Number, min: -180, max: 180, required: true },
  openingHours: { type: [new mongoose.Schema({ day: { type: Number, min: 0, max: 6 }, open: String, close: String }, { _id: false, strict: "throw" })], default: [] },
  active: { type: Boolean, default: true }, prepMinutes: { type: Number, min: 1, max: 240, default: 15 }, radiusMetres: { type: Number, min: 100, max: 50000, default: 8000 }, revision: count(1),
}, [[{ workspaceId: 1, _id: -1 }, {}]]);
const Courier = define("CommerceCourier", { userId: ref("User"), role: { type: String, enum: ["courier"], default: "courier", immutable: true },
  currentTripId: { type: mongoose.Schema.Types.ObjectId, default: null }, batchLoad: count(0),
  batchCapacity: { type: Number, min: 1, max: 30, default: 1 }, batchAutoAssign: { type: Boolean, default: false },
  address: text(1000), batchMode: { type: String, enum: ["fixed_zone", "first_customer"], default: "fixed_zone" },
  batchRadiusMetres: { type: Number, min: 100, max: 50000, default: 4000 }, pickupRadiusMetres: { type: Number, min: 100, max: 50000, default: 8000 },
  allowedZoneIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  name: { ...text(150), required: true }, phone: { ...text(15), required: true }, vehicle: { type: String, enum: ["motorcycle", "bicycle", "car"], default: "motorcycle" },
  allowedOutletIds: { type: [mongoose.Schema.Types.ObjectId], default: [] }, active: { type: Boolean, default: true }, online: { type: Boolean, default: false },
  location: { type: location, default: null }, geoPoint: { type: new mongoose.Schema({ type: { type: String, enum: ["Point"], required: true }, coordinates: { type: [Number], required: true, validate: (v) => v.length === 2 && Number.isFinite(v[0]) && Math.abs(v[0]) <= 180 && Number.isFinite(v[1]) && Math.abs(v[1]) <= 90 } }, { _id: false, strict: "throw" }), default: undefined },
  currentDeliveryId: { type: mongoose.Schema.Types.ObjectId, default: null }, revision: count(1),
}, [[{ userId: 1 }, { unique: true }], [{ workspaceId: 1, _id: -1 }, {}], [{ workspaceId: 1, geoPoint: "2dsphere" }, {}]]);
const RoutingSettings = define("CommerceDeliverySettings", {
  strategy: { type: String, enum: ["SMART", "NEAREST_PICKUP", "NEAREST_CUSTOMER", "MANUAL"], default: "SMART" },
  autoDispatch: { type: Boolean, default: false }, handoverSeconds: { type: Number, min: 0, max: 1800, default: 120 },
  allowedVehicles: { type: [String], enum: ["motorcycle", "bicycle", "car"], default: ["motorcycle", "bicycle", "car"] },
  branchAutoSelect: { type: Boolean, default: false },
  batchPriority: { type: String, enum: ["nearest_pickup", "existing_batch"], default: "nearest_pickup" },
  dispatchFence: count(0),
  pickupRadiusMetres: { type: Number, min: 100, max: 50000, default: 8000 },
  locationMaxAgeSeconds: { type: Number, min: 15, max: 300, default: 60 },
  maxAccuracyMetres: { type: Number, min: 1, max: 1000, default: 100 },
  routeShortlist: { type: Number, min: 1, max: 20, default: 5 },
  offerSeconds: { type: Number, min: 10, max: 120, default: 20 }, revision: count(1),
}, [[{ workspaceId: 1 }, { unique: true }]]);
const Delivery = define("CommerceDelivery", { orderId: ref("CommerceOrder"), outletId: { type: mongoose.Schema.Types.ObjectId, ref: "CommerceOutlet", required: true },
  tripId: { type: mongoose.Schema.Types.ObjectId, default: null },
  autoDispatchPaused: { type: Boolean, default: false }, autoNextAttemptAt: { type: Date, default: null }, autoAttempts: count(0),
  autoOfferedCourierIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  environment: { type: String, enum: ["test", "live"], required: true }, status: { type: String, enum: Object.keys(STATES), default: "pending_dispatch" },
  preparationStatus: { type: String, enum: ["accepted", "preparing", "ready", "rejected"], default: "accepted" }, prepMinutes: { type: Number, min: 1, max: 240, required: true }, readyAt: { type: Date, default: null },
  courierId: { type: mongoose.Schema.Types.ObjectId, default: null }, activeCourierId: { type: mongoose.Schema.Types.ObjectId, default: null },
  offerExpiresAt: { type: Date, default: null }, routingRequestedAt: { type: Date, default: null }, pickedUpAt: { type: Date, default: null }, offerKey: text(100), pickupEnc: secret(), destinationEnc: secret(),
  pinHash: secret(), pinEnc: secret(), pinFailures: count(0), pinBlockedUntil: { type: Date, default: null },
  trackingHash: { ...secret(), index: false }, trackingExpiresAt: { type: Date, default: null }, acceptedHash: text(64), lastReason: text(500), revision: count(1),
}, [[{ workspaceId: 1, orderId: 1 }, { unique: true }], [{ activeCourierId: 1 }, { unique: true, partialFilterExpression: { activeCourierId: { $type: "objectId" } } }],
  [{ workspaceId: 1, environment: 1, _id: -1 }, {}], [{ status: 1, offerExpiresAt: 1 }, {}], [{ status: 1, autoNextAttemptAt: 1, _id: 1 }, {}], [{ trackingHash: 1 }, { unique: true, partialFilterExpression: { trackingHash: { $type: "string", $gt: "" } } }]]);
const Notice = define("CommerceDeliveryNotice", { environment: { type: String, enum: ["test", "live"], default: "live" }, recipientId: { type: mongoose.Schema.Types.ObjectId, default: null }, deliveryId: { type: mongoose.Schema.Types.ObjectId, default: null },
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true }, kind: { ...text(60), required: true }, key: { ...text(150), required: true },
  actorId: text(100), reason: text(500), }, [[{ workspaceId: 1, key: 1 }, { unique: true }], [{ workspaceId: 1, recipientId: 1, _id: -1 }, {}], [{ workspaceId: 1, recipientId: 1, environment: 1, _id: -1 }, {}]]);
const Stock = define("CommerceOutletStock", { outletId: ref("CommerceOutlet"), productId: ref("CommerceProduct"), available: { type: Boolean, default: true },
  stockOnHand: count(0), stockReserved: count(0), revision: count(1) }, [[{ workspaceId: 1, outletId: 1, productId: 1 }, { unique: true }], [{ workspaceId: 1, productId: 1 }, {}], [{ workspaceId: 1, outletId: 1, _id: -1 }, {}]]);
const Zone = define("CommerceDeliveryZone", {
  dispatchFence: count(0),
  name: { ...text(150), required: true }, outletId: ref("CommerceOutlet"), latitude: { type: Number, min: -90, max: 90, required: true }, longitude: { type: Number, min: -180, max: 180, required: true },
  radiusMetres: { type: Number, min: 100, max: 50000, default: 4000 }, active: { type: Boolean, default: true }, autoAssign: { type: Boolean, default: false },
  priority: { type: Number, min: 0, max: 100, default: 10 }, prepToleranceSeconds: { type: Number, min: 0, max: 1800, default: 300 },
  maxWaitSeconds: { type: Number, min: 0, max: 1800, default: 300 }, maxTripSeconds: { type: Number, min: 300, max: 7200, default: 3600 },
  maxDetourSeconds: { type: Number, min: 0, max: 3600, default: 600 }, stopSeconds: { type: Number, min: 0, max: 600, default: 120 }, revision: count(1),
}, [[{ workspaceId: 1, _id: -1 }, {}], [{ workspaceId: 1, outletId: 1, active: 1, priority: 1, _id: 1 }, {}]]);
const Trip = define("CommerceDeliveryTrip", {
  outletId: ref("CommerceOutlet"), zoneId: { type: mongoose.Schema.Types.ObjectId, default: null },
  batchCentre: { type: new mongoose.Schema({ latitude: Number, longitude: Number, radiusMetres: Number }, { _id: false, strict: "throw" }), default: undefined },
  courierId: ref("CommerceCourier"),
  activeCourierId: { type: mongoose.Schema.Types.ObjectId, default: null }, environment: { type: String, enum: ["test", "live"], required: true },
  status: { type: String, enum: ["loading", "departed", "completed"], default: "loading" },
  deliveryIds: { type: [mongoose.Schema.Types.ObjectId], default: [], validate: (v) => v.length <= 30 },
  latestDepartureAt: { type: Date, required: true }, revision: count(1),
}, [[{ activeCourierId: 1 }, { unique: true, partialFilterExpression: { activeCourierId: { $type: "objectId" } } }], [{ workspaceId: 1, _id: -1 }, {}]]);
module.exports = { Outlet, Courier, Delivery, Notice, Stock, RoutingSettings, Zone, Trip, location };
