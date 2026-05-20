const mongoose = require("mongoose");

const CrmAssignmentAuditSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    phone: { type: String, required: true, index: true },
    fromEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    toEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null, index: true },
    mode: { type: String, default: "" },
    reason: { type: String, default: "" },
    assignedBy: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

CrmAssignmentAuditSchema.index({ workspaceId: 1, createdAt: -1 });

const CrmAssignmentAudit = mongoose.model("CrmAssignmentAudit", CrmAssignmentAuditSchema);

module.exports = { CrmAssignmentAudit };

