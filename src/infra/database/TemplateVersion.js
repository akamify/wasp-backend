const mongoose = require("mongoose");

const TemplateVersionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
      default: null,
      index: true,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Template",
      required: true,
      index: true,
    },
    versionNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    action: {
      type: String,
      enum: ["created", "updated", "restored", "submitted", "synced", "published", "archived", "duplicated"],
      default: "updated",
    },
    updatedBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      email: { type: String, default: null },
      name: { type: String, default: null },
    },
    changes: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: true }
);

TemplateVersionSchema.index({ workspaceId: 1, templateId: 1, versionNumber: -1 }, { unique: true });
TemplateVersionSchema.index({ workspaceId: 1, templateId: 1, createdAt: -1 });

const TemplateVersion = mongoose.model("TemplateVersion", TemplateVersionSchema);

module.exports = { TemplateVersion };
