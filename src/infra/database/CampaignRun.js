const mongoose = require("mongoose");

const CampaignRunSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      required: true,
      index: true,
    },
    scheduledFor: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "running", "completed", "failed"],
      default: "pending",
      index: true,
    },
    total: { type: Number, default: 0, min: 0 },
    processed: { type: Number, default: 0, min: 0 },
    sent: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date },
    completedAt: { type: Date },
    error: { type: Object },
  },
  { timestamps: true }
);

CampaignRunSchema.index({ campaignId: 1, scheduledFor: 1 }, { unique: true });

const CampaignRun = mongoose.model("CampaignRun", CampaignRunSchema);

module.exports = { CampaignRun };
