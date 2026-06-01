const mongoose = require("mongoose");

const WorkspaceActivityLogSchema = new mongoose.Schema(
  {
    workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    action: { type: String, required: true, trim: true, index: true },
    entityType: { type: String, required: true, trim: true, index: true },
    entityId: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

WorkspaceActivityLogSchema.index({ workspaceId: 1, createdAt: -1 });
WorkspaceActivityLogSchema.index({ workspaceId: 1, action: 1, createdAt: -1 });

const WorkspaceActivityLog = mongoose.model("WorkspaceActivityLog", WorkspaceActivityLogSchema);

module.exports = { WorkspaceActivityLog };
