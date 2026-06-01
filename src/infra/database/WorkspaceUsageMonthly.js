const mongoose = require("mongoose");

const WorkspaceUsageMonthlySchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    period: { type: String, required: true, trim: true, index: true },
    contactsCount: { type: Number, default: 0 },
    campaignsSent: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    templatesCount: { type: Number, default: 0 },
    agentsCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

WorkspaceUsageMonthlySchema.index({ workspaceId: 1, period: 1 }, { unique: true });

const WorkspaceUsageMonthly = mongoose.model("WorkspaceUsageMonthly", WorkspaceUsageMonthlySchema);

module.exports = { WorkspaceUsageMonthly };
