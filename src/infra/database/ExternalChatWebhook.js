const mongoose = require("mongoose");

const ExternalChatWebhookSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    apiKeyId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    url: { type: String, required: true, trim: true },
    events: [{ type: String, trim: true }],
    enabled: { type: Boolean, default: true, index: true },
    secret: { type: String, required: true, select: false },
    secretHash: { type: String, required: true, select: false },
    lastDelivery: {
      status: { type: String, enum: ["pending", "success", "failed"], default: undefined },
      statusCode: { type: Number, default: null },
      event: { type: String, default: null },
      deliveryId: { type: String, default: null },
      error: { type: String, default: "" },
      at: { type: Date, default: null },
    },
    failureCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ExternalChatWebhookSchema.index({ workspaceId: 1, enabled: 1 });
ExternalChatWebhookSchema.index({ workspaceId: 1, apiKeyId: 1 });

const ExternalChatWebhook = mongoose.model("ExternalChatWebhook", ExternalChatWebhookSchema);

module.exports = { ExternalChatWebhook };
