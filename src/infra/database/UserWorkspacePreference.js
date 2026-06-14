const mongoose = require("mongoose");

const AutomationBuilderPreferencesSchema = new mongoose.Schema(
  {
    leftSidebarCollapsed: { type: Boolean, default: false },
    rightSettingsOpen: { type: Boolean, default: true },
    leftSidebarWidth: { type: Number, min: 64, max: 360, default: 280 },
    rightSettingsWidth: { type: Number, min: 300, max: 520, default: 360 },
    lastActivePanel: {
      type: String,
      enum: ["flow_settings", "node_settings"],
      default: "flow_settings",
    },
    lastActiveLeftTab: {
      type: String,
      enum: ["messages", "actions"],
      default: "messages",
    },
  },
  { _id: false }
);

const UserWorkspacePreferenceSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    scope: {
      type: String,
      enum: ["automation_builder"],
      required: true,
    },
    preferences: {
      type: AutomationBuilderPreferencesSchema,
      default: () => ({}),
    },
  },
  { timestamps: true }
);

UserWorkspacePreferenceSchema.index(
  { userId: 1, workspaceId: 1, scope: 1 },
  { unique: true }
);

const UserWorkspacePreference = mongoose.model(
  "UserWorkspacePreference",
  UserWorkspacePreferenceSchema
);

module.exports = { UserWorkspacePreference };
