const mongoose = require("mongoose");

const AiBudgetConfigSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true, index: true },
    monthlyCreditBudget: { type: Number, default: 0, min: 0 },
    monthlyCreditWarning: { type: Number, default: 0, min: 0 },
    lowCreditWarning: { type: Number, default: 0, min: 0 },
    nearExhaustionWarning: { type: Number, default: 0, min: 0 },
    notificationsEnabled: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    lastEvaluatedAt: { type: Date, default: null },
    lastAlertState: { type: mongoose.Schema.Types.Mixed, default: {} },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const AiBudgetConfig = mongoose.model("AiBudgetConfig", AiBudgetConfigSchema);

module.exports = { AiBudgetConfig };
