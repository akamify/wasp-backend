const mongoose = require("mongoose");

const WorkspaceSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    plan: { type: String, default: "free" },
    allowedApiPermissions: {
      campaignSend: { type: Boolean, default: true },
      chatAccess: { type: Boolean, default: false },
    },
    features: {
      externalChatApiAccess: { type: Boolean, default: false, index: true },
    },
    crmEnabled: { type: Boolean, default: false, index: true },
    crmSettings: {
      leadWindowHours: { type: Number, default: 48, min: 1, max: 720 },
      assignmentLockMinutes: { type: Number, default: 5, min: 1, max: 120 },
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

WorkspaceSchema.index({ ownerId: 1, name: 1 });

const Workspace = mongoose.model("Workspace", WorkspaceSchema);

module.exports = { Workspace };

