const { define } = require("@modules/commerce/models/schema");

// The deterministic primary key serializes setup per workspace/WABA without a new index migration.
const CommerceCatalogSetup = define("CommerceCatalogSetup", {
  _id: { type: String, required: true },
  wabaId: { type: String, required: true, immutable: true },
  phoneNumberId: { type: String, required: true, immutable: true },
  businessId: { type: String, required: true, immutable: true },
  name: { type: String, required: true, maxlength: 150 },
  catalogId: { type: String, default: "" },
  state: { type: String, enum: ["ready", "creating", "created", "connected"], default: "ready" },
  leaseOwner: { type: String, default: "" },
  leaseUntil: { type: Date, default: null },
});
module.exports = { CommerceCatalogSetup };
