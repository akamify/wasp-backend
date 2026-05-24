const mongoose = require("mongoose");

const EmployeeLoginEventSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    type: { type: String, enum: ["login", "logout"], required: true, index: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

EmployeeLoginEventSchema.index({ workspaceId: 1, employeeId: 1, createdAt: -1 });

const EmployeeLoginEvent = mongoose.model("EmployeeLoginEvent", EmployeeLoginEventSchema);

module.exports = { EmployeeLoginEvent };

