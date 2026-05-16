const mongoose = require("mongoose");

const TemplateMediaSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    handle: { type: String, required: true, index: true },
    originalName: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    storageType: { type: String, enum: ["mongo", "file"], default: "mongo" },
    filePath: { type: String, default: "" },
    data: { type: Buffer, required: false },
  },
  { timestamps: true }
);

TemplateMediaSchema.index({ workspaceId: 1, handle: 1 }, { unique: true });

const TemplateMedia = mongoose.model("TemplateMedia", TemplateMediaSchema);

module.exports = { TemplateMedia };
