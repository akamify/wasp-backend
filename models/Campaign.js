const mongoose = require("mongoose");

const CampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: "Template", required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "queued", "running", "completed", "failed", "paused", "canceled"],
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

const Campaign = mongoose.model("Campaign", CampaignSchema);

module.exports = { Campaign };

