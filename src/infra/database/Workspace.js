const mongoose = require("mongoose");

const WorkspaceSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, default: null },
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, lowercase: true, default: null },
    businessName: { type: String, trim: true, default: null },
    status: { type: String, enum: ["active", "suspended", "deleted"], default: "active", index: true },
    deletedAt: { type: Date, default: null, index: true },
    defaultCurrency: { type: String, default: "INR" },
    timezone: { type: String, default: "Asia/Calcutta" },
    logoUrl: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    industry: { type: String, default: null },
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
WorkspaceSchema.index({ slug: 1 }, { unique: true, sparse: true });
WorkspaceSchema.index({ status: 1, createdAt: -1 });

const Workspace = mongoose.model("Workspace", WorkspaceSchema);

module.exports = { Workspace };

