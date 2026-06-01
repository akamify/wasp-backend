const mongoose = require("mongoose");

const CampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    wabaId: { type: String, trim: true, index: true, default: null },
    phoneNumberId: { type: String, trim: true, index: true, default: null },
    name: { type: String, required: true, trim: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true, index: true },
    type: {
      type: String,
      enum: ["broadcast", "csv", "api"],
      default: "broadcast",
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "queued", "running", "completed", "failed", "paused", "canceled", "cancelled"],
      default: "draft",
      index: true,
    },
    scheduledAt: { type: Date },
    totals: {
      total: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    lastError: { type: Object },
  },
  { timestamps: true }
);

CampaignSchema.index({ workspaceId: 1, createdAt: -1 });
CampaignSchema.index({ workspaceId: 1, wabaId: 1, createdAt: -1 });

const Campaign = mongoose.model("Campaign", CampaignSchema);

module.exports = { Campaign };
