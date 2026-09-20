const {
  define,
  mongoose,
  ref,
  amount,
  count,
} = require("@modules/commerce/models/schema");
const CommerceOrder = define(
  "CommerceOrder",
  {
    catalogConnectionId: ref("CommerceCatalogConnection"),
    recommendedOutletId: { type: mongoose.Schema.Types.ObjectId, default: null },
    branchRoutingStatus: { type: String, enum: ["pending", "suggested", "manual"], default: "manual" },
    branchRoutingNextAt: { type: Date, default: null }, branchRoutingToken: { type: String, default: "" }, branchRoutingAttempts: count(0),
    manualDeliveryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    wabaId: { type: String, required: true, immutable: true },
    phoneNumberId: { type: String, required: true, immutable: true },
    inboundMessageId: { type: String, required: true, immutable: true },
    orderNumber: { type: String, required: true, immutable: true },
    customerPhone: { type: String, required: true, immutable: true },
    customerName: { type: String, maxlength: 150, default: "" },
    customerNoteEnc: { type: String, default: "", select: false },
    receivedAt: { type: Date, default: Date.now, immutable: true },
    sourceItems: { type: [new mongoose.Schema({
      sku: { type: String, required: true, maxlength: 100 },
      quantity: { ...count(1), min: 1, max: 10000 },
      unitPricePaise: amount(),
    }, { _id: false, strict: "throw" })], default: [], immutable: true,
      validate: (items) => items.length <= 100 && new Set(items.map((item) => item.sku)).size === items.length },
    environment: {
      type: String,
      enum: ["test", "live"],
      default: "live",
      immutable: true,
    },
    status: {
      type: String,
      enum: Object.keys(
        require("@modules/commerce/domain/states").ORDER_TRANSITIONS,
      ),
      default: "needs_details",
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "pending", "captured"],
      default: "unpaid",
    },
    currency: { type: String, enum: ["INR"], default: "INR", immutable: true },
    items: {
      type: [
        new mongoose.Schema(
          {
            productId: ref("CommerceProduct"),
            sku: { type: String, required: true },
            name: String,
            quantity: { ...count(1), min: 1, max: 10000 },
            unitPricePaise: amount(),
            productRevision: { ...count(1), min: 1 },
            taxRateBps: { type: Number, default: null, min: 0, max: 10000, validate: (v) => v == null || Number.isInteger(v) },
            grossPaise: amount(),
            includedTaxPaise: { ...amount(null), validate: (v) => v == null || Number.isSafeInteger(v) },
          },
          { _id: false, strict: "throw" },
        ),
      ],
      default: [],
      validate: (v) => v.length >= 1 && v.length <= 100 && new Set(v.map((item) => item.sku)).size === v.length,
    },
    subtotalPaise: amount(),
    deliveryPaise: amount(),
    deliveryTaxRateBps: { type: Number, default: null, min: 0, max: 10000, validate: (v) => v == null || Number.isInteger(v) },
    deliveryIncludedTaxPaise: { ...amount(null), validate: (v) => v == null || Number.isSafeInteger(v) },
    totalPaise: amount(),
    includedTaxPaise: { ...amount(null), validate: (v) => v == null || Number.isSafeInteger(v) },
    warnings: { type: [String], default: [] },
    fulfillmentMethod: {
      type: String,
      enum: ["", "pickup", "delivery"],
      default: "",
    },
    addressEnc: { type: String, default: "", select: false },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: "" },
    revision: count(1),
    activeAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommerceCheckoutAttempt",
      default: null,
    },
    paidAttemptId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CommerceCheckoutAttempt",
      default: null,
    },
    paidAt: { type: Date, default: null },
    attentionReason: { type: String, default: "", maxlength: 300 },
  },
  [
    [{ branchRoutingStatus: 1, branchRoutingNextAt: 1, _id: 1 }, {}],
    [{ workspaceId: 1, recommendedOutletId: 1, environment: 1, _id: -1 }, {}],
    [{ workspaceId: 1, environment: 1, customerPhone: 1, _id: -1 }, {}],
    [{ workspaceId: 1, environment: 1, _id: -1 }, {}],
    [
      {
        workspaceId: 1,
        wabaId: 1,
        inboundMessageId: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        orderNumber: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        workspaceId: 1,
        environment: 1,
        status: 1,
        _id: -1,
      },
    ],
  ],
);
module.exports = { CommerceOrder };
