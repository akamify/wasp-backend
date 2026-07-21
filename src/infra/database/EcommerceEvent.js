const mongoose = require("mongoose");

const EcommerceEventSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "EcommerceStore", required: true, index: true },
    platform: { type: String, trim: true, lowercase: true, required: true },
    topic: { type: String, trim: true, required: true },
    externalEventId: { type: String, trim: true, default: "" },
    idempotencyKey: { type: String, trim: true, required: true },
    status: { type: String, trim: true, default: "received", index: true },
    summary: { type: String, trim: true, default: "" },
    receivedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
    error: { type: String, trim: true, default: "" },
    payloadPreview: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

EcommerceEventSchema.index({ workspaceId: 1, storeId: 1, createdAt: -1 });
EcommerceEventSchema.index({ workspaceId: 1, idempotencyKey: 1 }, { unique: true });

const EcommerceEvent = mongoose.models.EcommerceEvent || mongoose.model("EcommerceEvent", EcommerceEventSchema);

module.exports = { EcommerceEvent };
