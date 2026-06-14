const { MediaAsset } = require("@infra/database/MediaAsset");

function createMediaAsset(data) {
  return MediaAsset.create(data);
}

function findMediaAssetById({ workspaceId, mediaAssetId }) {
  return MediaAsset.findOne({
    _id: mediaAssetId,
    workspaceId,
    status: "ready",
  });
}

function listMediaAssets({ workspaceId, mediaType, limit = 50 }) {
  return MediaAsset.find({
    workspaceId,
    status: "ready",
    ...(mediaType ? { mediaType } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(limit);
}

function softDeleteMediaAsset({ workspaceId, mediaAssetId }) {
  return MediaAsset.findOneAndUpdate(
    { _id: mediaAssetId, workspaceId, status: { $ne: "deleted" } },
    { $set: { status: "deleted" } },
    { new: true }
  );
}

module.exports = {
  createMediaAsset,
  findMediaAssetById,
  listMediaAssets,
  softDeleteMediaAsset,
};
