const mongoose = require("mongoose");

const CrmLeadSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    phone: { type: String, required: true, index: true },
    status: { type: String, default: "OPEN", index: true },
    assignedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    assignedAt: { type: Date, default: null },
    lastInboundAt: { type: Date, default: null, index: true },
    firstInboundAt: { type: Date, default: null, index: true },
    lastActivityAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null },
    source: {
      type: { type: String, default: "" },
      campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", default: null },
      adId: { type: String, default: "" },
      referrer: { type: String, default: "" },
      utm: { type: Object, default: null },
    },
    tags: { type: [String], default: [] },
  },
  { timestamps: true }
);

CrmLeadSchema.index({ workspaceId: 1, phone: 1 }, { unique: true });
CrmLeadSchema.index({ workspaceId: 1, assignedEmployeeId: 1, status: 1, createdAt: -1 });

const CrmLead = mongoose.model("CrmLead", CrmLeadSchema);

module.exports = { CrmLead };

