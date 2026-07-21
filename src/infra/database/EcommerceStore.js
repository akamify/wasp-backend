const mongoose = require("mongoose");

const EcommerceWebhookSchema = new mongoose.Schema(
  {
    externalWebhookId: { type: String, trim: true, default: "" },
    topic: { type: String, trim: true, required: true },
    status: { type: String, trim: true, default: "pending" },
    managedBy: { type: String, trim: true, default: "ai_wiz_chat" },
    lastSuccessfulDeliveryAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
    lastFailureReason: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const EcommerceStoreSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    platform: { type: String, trim: true, lowercase: true, required: true, enum: ["woocommerce"] },
    storeName: { type: String, trim: true, required: true },
    storeUrl: { type: String, trim: true, required: true },
    storeDomain: { type: String, trim: true, lowercase: true, default: "" },
    status: {
      type: String,
      trim: true,
      default: "connecting",
      enum: ["not_connected", "connecting", "connected", "reconnecting", "connection_error", "degraded", "paused", "disconnected"],
      index: true,
    },
    credentials: {
      consumerKeyEnc: { type: String, default: "" },
      consumerSecretEnc: { type: String, default: "" },
      webhookSecretEnc: { type: String, default: "" },
      keyPrefix: { type: String, trim: true, default: "" },
      lastUpdatedAt: { type: Date, default: null },
    },
    connectionHealth: {
      apiCredentialsValid: { type: Boolean, default: false },
      apiAccessValid: { type: Boolean, default: false },
      webhooksConfigured: { type: Boolean, default: false },
      lastStatusCode: { type: Number, default: 0 },
      lastError: { type: String, trim: true, default: "" },
    },
    webhooks: { type: [EcommerceWebhookSchema], default: [] },
    lastConnectedAt: { type: Date, default: null },
    lastSuccessfulCheckAt: { type: Date, default: null },
    lastWebhookEventAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    disconnectedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

EcommerceStoreSchema.index({ workspaceId: 1, platform: 1, storeUrl: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
EcommerceStoreSchema.index({ workspaceId: 1, platform: 1, status: 1 });

const EcommerceStore = mongoose.models.EcommerceStore || mongoose.model("EcommerceStore", EcommerceStoreSchema);

module.exports = { EcommerceStore };
