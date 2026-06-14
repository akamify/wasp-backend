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
    displayName: asset.displayName || asset.originalName,
    mimeType: asset.mimeType,
    extension: asset.extension,
    sizeBytes: asset.sizeBytes,
    mediaType: asset.mediaType,
    publicUrl: asset.publicUrl,
    status: asset.status,
    createdAt: asset.createdAt,
  };
}

async function uploadMediaAsset({
  workspaceId,
  uploadedBy,
  mediaType,
  displayName,
  file,
}) {
  if (!file) {
    throw new HttpError(400, "File is required", { code: "MEDIA_FILE_REQUIRED" });
  }
  const validation = validateMediaFile({
    mediaType,
    mimeType: file.mimetype,
    originalName: file.originalname,
    sizeBytes: file.size,
    buffer: file.buffer,
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
    displayName: String(displayName || file.originalname).trim(),
    storageProvider: uploaded.storageProvider,
    storageKey: uploaded.storageKey,
    publicUrl: uploaded.publicUrl,
    mimeType: file.mimetype,
    extension: validation.extension,
    sizeBytes: file.size,
    mediaType: validation.mediaType,
    checksum: uploaded.checksum,
    checksumSha256: uploaded.checksum,
    status: "ready",
  });
  return { ok: true, asset: serializeMediaAsset(asset) };
}

async function listMediaAssets({
  workspaceId,
  mediaType,
  search,
  page,
  limit,
}) {
  const result = await mediaAssetRepository.listMediaAssets({
    workspaceId,
    mediaType,
    search,
    page,
    limit,
  });
  return {
    ok: true,
    items: result.items.map(serializeMediaAsset),
    pagination: {
      page,
      limit,
      total: result.total,
      pages: Math.max(1, Math.ceil(result.total / limit)),
    },
  };
}

async function getMediaAsset({ workspaceId, mediaAssetId }) {
  const asset = await mediaAssetRepository.getMediaAsset({
    workspaceId,
    mediaAssetId,
  });
  if (!asset) {
    throw new HttpError(404, "Media asset not found", {
      code: "MEDIA_ASSET_NOT_FOUND",
    });
  }
  return { ok: true, asset: serializeMediaAsset(asset) };
}

async function updateMediaAsset({ workspaceId, mediaAssetId, displayName }) {
  const asset = await mediaAssetRepository.updateMediaAssetDisplayName({
    workspaceId,
    mediaAssetId,
    displayName: String(displayName || "").trim(),
  });
  if (!asset) {
    throw new HttpError(404, "Media asset not found", {
      code: "MEDIA_ASSET_NOT_FOUND",
    });
  }
  return { ok: true, asset: serializeMediaAsset(asset) };
}

async function deleteMediaAsset({ workspaceId, mediaAssetId }) {
  const used = await mediaAssetRepository.isMediaAssetUsedByPublishedFlow({
    workspaceId,
    mediaAssetId,
  });
  if (used) {
    throw new HttpError(409, "Media asset is used by an active published flow", {
      code: "MEDIA_ASSET_IN_USE",
    });
  }
  const asset = await mediaAssetRepository.softDeleteMediaAsset({
    workspaceId,
    mediaAssetId,
  });
  if (!asset) {
    throw new HttpError(404, "Media asset not found", {
      code: "MEDIA_ASSET_NOT_FOUND",
    });
  }
  return { ok: true };
}

module.exports = {
  deleteMediaAsset,
  getMediaAsset,
  listMediaAssets,
  serializeMediaAsset,
  updateMediaAsset,
  uploadMediaAsset,
};
