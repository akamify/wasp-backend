const mongoose = require("mongoose");

const WorkspaceMemberSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: {
      type: String,
      enum: ["owner", "admin", "manager", "agent", "viewer"],
      default: "viewer",
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "invited", "removed"],
      default: "active",
      index: true,
    },
    permissionsOverride: { type: mongoose.Schema.Types.Mixed, default: {} },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    joinedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

WorkspaceMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
WorkspaceMemberSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

const WorkspaceMember = mongoose.model("WorkspaceMember", WorkspaceMemberSchema);

module.exports = { WorkspaceMember };
