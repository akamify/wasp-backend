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
    displayName: { type: String, trim: true, default: "" },
    storageProvider: {
      type: String,
      enum: ["local", "s3", "r2", "cloudinary"],
      default: "cloudinary",
    },
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
    checksumSha256: { type: String, trim: true, default: "" },
    metaMediaCache: {
      type: [
        {
          phoneNumberId: { type: String, trim: true, required: true },
          mediaId: { type: String, trim: true, required: true },
          uploadedAt: { type: Date, required: true },
          expiresAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    usedBy: {
      type: [
        {
          flowId: { type: mongoose.Schema.Types.ObjectId, ref: "Flow" },
          nodeId: { type: String, trim: true },
          flowVersionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FlowVersion",
            default: null,
          },
        },
      ],
      default: [],
    },
    status: {
      type: String,
      enum: ["ready", "failed", "deleted"],
      default: "ready",
      index: true,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

MediaAssetSchema.index({ workspaceId: 1, mediaType: 1, status: 1 });
MediaAssetSchema.index({ workspaceId: 1, createdAt: -1 });
MediaAssetSchema.index({ workspaceId: 1, checksumSha256: 1 });

const MediaAsset = mongoose.model("MediaAsset", MediaAssetSchema);

module.exports = { MediaAsset };
