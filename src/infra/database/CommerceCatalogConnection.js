const { define, count } = require("@modules/commerce/models/schema");
const CommerceCatalogConnection = define(
  "CommerceCatalogConnection",
  {
    wabaId: { type: String, required: true, immutable: true },
    phoneNumberId: { type: String, required: true, immutable: true },
    catalogId: { type: String, required: true, immutable: true },
    businessId: { type: String, default: "" },
    graphApiVersion: { type: String, required: true },
    active: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["connected", "error", "disconnected"],
      default: "connected",
    },
    catalogVisible: { type: Boolean, default: false },
    cartEnabled: { type: Boolean, default: false },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: "", maxlength: 300 },
    revision: count(1),
    syncLeaseUntil: { type: Date, default: null },
    syncLeaseOwner: { type: String, default: "", select: false },
  },
  [
    [
      {
        workspaceId: 1,
        wabaId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          active: true,
        },
      },
    ],
    [
      {
        catalogId: 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          active: true,
        },
      },
    ],
  ],
);
module.exports = { CommerceCatalogConnection };
