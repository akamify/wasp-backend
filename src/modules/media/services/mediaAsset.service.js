const { HttpError } = require("@shared/utils/httpError");
const {
  validateMediaFile,
} = require("@shared/utils/mediaValidation");
const mediaAssetRepository = require("@modules/media/repositories/mediaAsset.repository");
const { uploadMediaObject } = require("@modules/media/services/mediaStorage.service");

function serializeMediaAsset(asset) {
  return {
    id: String(asset._id),
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    extension: asset.extension,
    sizeBytes: asset.sizeBytes,
    mediaType: asset.mediaType,
    publicUrl: asset.publicUrl,
    status: asset.status,
    createdAt: asset.createdAt,
  };
}

async function uploadMediaAsset({ workspaceId, uploadedBy, mediaType, file }) {
  if (!file) {
    throw new HttpError(400, "File is required", { code: "MEDIA_FILE_REQUIRED" });
  }
  const validation = validateMediaFile({
    mediaType,
    mimeType: file.mimetype,
    originalName: file.originalname,
    sizeBytes: file.size,
  });
  let uploaded;
  try {
    uploaded = await uploadMediaObject({
      workspaceId,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      extension: validation.extension,
    });
  } catch (error) {
    throw new HttpError(500, "Media upload failed", {
      code: "MEDIA_UPLOAD_FAILED",
      message: error?.message || "Media upload failed",
    });
  }
  if (!uploaded.publicUrl) {
    throw new HttpError(500, "Media upload failed", {
      code: "MEDIA_UPLOAD_FAILED",
    });
  }
  const asset = await mediaAssetRepository.createMediaAsset({
    workspaceId,
    uploadedBy: uploadedBy || null,
    originalName: file.originalname,
    storageKey: uploaded.storageKey,
    publicUrl: uploaded.publicUrl,
    mimeType: file.mimetype,
    extension: validation.extension,
    sizeBytes: file.size,
    mediaType: validation.mediaType,
    checksum: uploaded.checksum,
    status: "ready",
  });
  return { success: true, asset: serializeMediaAsset(asset) };
}

async function listMediaAssets({ workspaceId, mediaType }) {
  const assets = await mediaAssetRepository.listMediaAssets({
    workspaceId,
    mediaType,
  });
  return { success: true, assets: assets.map(serializeMediaAsset) };
}

async function deleteMediaAsset({ workspaceId, mediaAssetId }) {
  const asset = await mediaAssetRepository.softDeleteMediaAsset({
    workspaceId,
    mediaAssetId,
  });
  if (!asset) {
    throw new HttpError(404, "Media asset not found", {
      code: "MEDIA_ASSET_NOT_FOUND",
    });
  }
  return { success: true };
}

module.exports = {
  deleteMediaAsset,
  listMediaAssets,
  serializeMediaAsset,
  uploadMediaAsset,
};
