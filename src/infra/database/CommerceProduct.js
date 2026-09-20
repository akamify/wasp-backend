const {
  define,
  ref,
  amount,
  count,
} = require("@modules/commerce/models/schema");
const CommerceProduct = define(
  "CommerceProduct",
  {
    catalogConnectionId: ref("CommerceCatalogConnection"),
    inventoryOutletId: { type: require("mongoose").Schema.Types.ObjectId, default: null },
    sku: { type: String, required: true, immutable: true, maxlength: 100 },
    name: { type: String, required: true, maxlength: 150 },
    description: { type: String, default: "", maxlength: 5000 },
    imageUrl: { type: String, required: true, maxlength: 2048 },
    productUrl: { type: String, required: true, maxlength: 2048 },
    category: { type: String, default: "", maxlength: 100 },
    brand: { type: String, default: "", maxlength: 100 },
    condition: { type: String, enum: ["new", "refurbished", "used", null], default: null },
    pricePaise: amount(),
    taxRateBps: {
      type: Number,
      default: null,
      min: 0,
      max: 10000,
      validate: (v) => v == null || Number.isInteger(v),
    },
    taxConfirmed: { type: Boolean, default: false },
    available: { type: Boolean, default: true },
    trackInventory: { type: Boolean, default: false },
    stockOnHand: count(),
    stockReserved: count(),
    archivedAt: { type: Date, default: null },
    revision: count(1),
    syncedRevision: count(),
    metaProductId: { type: String, default: "" },
    syncStatus: {
      type: String,
      enum: ["pending", "accepted", "synced", "error"],
      default: "pending",
    },
    syncError: { type: String, default: "", maxlength: 300 },
    syncLeaseUntil: { type: Date, default: null },
    syncLeaseOwner: { type: String, default: "", select: false },
    syncNextAttemptAt: { type: Date, default: Date.now },
    syncAttempts: count(),
    syncSubmittedRevision: count(),
    metaReviewStatus: { type: String, enum: ["unknown", "pending", "approved", "rejected", "outdated"], default: "unknown" },
    metaVisibility: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
  },
  [
    [{ syncStatus: 1, syncNextAttemptAt: 1, syncLeaseUntil: 1 }, {}],
    [{ workspaceId: 1, catalogConnectionId: 1, archivedAt: 1, _id: -1 }, {}],
    [
      {
        workspaceId: 1,
        catalogConnectionId: 1,
        sku: 1,
      },
      {
        unique: true,
      },
    ],
    [
      {
        workspaceId: 1,
        archivedAt: 1,
        _id: -1,
      },
    ],
    [
      {
        syncStatus: 1,
        syncLeaseUntil: 1,
        updatedAt: 1,
      },
    ],
  ],
);
module.exports = { CommerceProduct };
