const mongoose = require("mongoose");

const MediaAssetSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    originalName: { type: String, trim: true, required: true },
    storageKey: { type: String, trim: true, required: true },
    publicUrl: { type: String, trim: true, required: true },
    mimeType: { type: String, trim: true, required: true },
    extension: { type: String, trim: true, required: true },
    sizeBytes: { type: Number, required: true },
    mediaType: {
      type: String,
      enum: ["image", "video", "audio", "document"],
      required: true,
      index: true,
    },
    checksum: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["ready", "failed", "deleted"],
      default: "ready",
      index: true,
    },
  },
  { timestamps: true }
);

MediaAssetSchema.index({ workspaceId: 1, mediaType: 1, status: 1, createdAt: -1 });

const MediaAsset = mongoose.model("MediaAsset", MediaAssetSchema);

module.exports = { MediaAsset };
