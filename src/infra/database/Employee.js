const mongoose = require("mongoose");

const EmployeeSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true, default: "" },
    // Only two roles are supported in UI: employee, team_leader.
    // Keep as string for forward-compat; default must be employee.
    role: { type: String, trim: true, default: "employee" },
    status: { type: String, enum: ["ACTIVE", "BLOCKED", "DISABLED", "DELETED"], default: "ACTIVE", index: true },
    twoFactorEnabled: { type: Boolean, default: true },
    permissions: {
      canReply: { type: Boolean, default: true },
      canViewMedia: { type: Boolean, default: true },
      canDownloadMedia: { type: Boolean, default: true },
      canEditContact: { type: Boolean, default: false },
      canTagLead: { type: Boolean, default: true },
      canCloseLead: { type: Boolean, default: true },
      canExportLeads: { type: Boolean, default: false },
      canViewAnalytics: { type: Boolean, default: false },
    },

    // Assignment constraints / foundation fields
    maxActiveLeads: { type: Number, default: null },
    assignmentWeight: { type: Number, default: 1 },

    assignedChatsCount: { type: Number, default: 0 },
    lastLoginAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // Session invalidation
    sessionVersion: { type: Number, default: 0 },

    // Password reset
    passwordResetTokenHash: { type: String, select: false },
    passwordResetTokenExpiresAt: { type: Date, select: false },

    // Owner-approved profile changes (OTP where required)
    profileOtpCodeHash: { type: String, select: false },
    profileOtpCodeExpiresAt: { type: Date, select: false },
    profileOtpPurpose: { type: String, select: false },
    pendingEmail: { type: String, trim: true, lowercase: true, select: false },

    // Soft delete
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

EmployeeSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
EmployeeSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

const Employee = mongoose.model("Employee", EmployeeSchema);

module.exports = { Employee };
