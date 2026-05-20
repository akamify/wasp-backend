const mongoose = require("mongoose");

const ProcessedWebhookEventSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    provider: { type: String, required: true, trim: true, default: "meta", index: true },
    eventKey: { type: String, required: true, trim: true },
    processedAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false }
);

ProcessedWebhookEventSchema.index({ provider: 1, workspaceId: 1, eventKey: 1 }, { unique: true });
ProcessedWebhookEventSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const ProcessedWebhookEvent = mongoose.model("ProcessedWebhookEvent", ProcessedWebhookEventSchema);

module.exports = { ProcessedWebhookEvent };

