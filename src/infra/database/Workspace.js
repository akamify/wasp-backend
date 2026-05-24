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
      assignmentLockMinutes: { type: Number, default: 5, min: 0, max: 10 },
      autoAssignEnabled: { type: Boolean, default: true },
      assignmentMode: {
        type: String,
        enum: ["ROUND_ROBIN", "LEAST_ACTIVE", "FIXED_LIMIT", "MANUAL"],
        default: "ROUND_ROBIN",
      },
      autoAssignFromTime: { type: String, default: null }, // "HH:mm" (server local time)
      autoAssignToTime: { type: String, default: null }, // "HH:mm" (server local time)
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

WorkspaceSchema.index({ ownerId: 1, name: 1 });

const Workspace = mongoose.model("Workspace", WorkspaceSchema);

module.exports = { Workspace };

