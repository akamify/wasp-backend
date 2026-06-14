const { MediaAsset } = require("@infra/database/MediaAsset");
const { Flow } = require("@infra/database/Flow");
const { FlowVersion } = require("@infra/database/FlowVersion");

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

function getMediaAsset({ workspaceId, mediaAssetId }) {
  return MediaAsset.findOne({
    _id: mediaAssetId,
    workspaceId,
    status: { $ne: "deleted" },
  });
}

async function listMediaAssets({
  workspaceId,
  mediaType,
  search,
  page = 1,
  limit = 24,
}) {
  const query = {
    workspaceId,
    status: "ready",
    ...(mediaType ? { mediaType } : {}),
    ...(search
      ? {
          $or: [
            { originalName: { $regex: search, $options: "i" } },
            { displayName: { $regex: search, $options: "i" } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    MediaAsset.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    MediaAsset.countDocuments(query),
  ]);
  return { items, total };
}

function updateMediaAssetDisplayName({ workspaceId, mediaAssetId, displayName }) {
  return MediaAsset.findOneAndUpdate(
    { _id: mediaAssetId, workspaceId, status: "ready" },
    { $set: { displayName } },
    { new: true, runValidators: true }
  );
}

async function isMediaAssetUsedByPublishedFlow({ workspaceId, mediaAssetId }) {
  const nodeMatch = {
    $elemMatch: {
      type: "media",
      "config.mediaAssetId": String(mediaAssetId),
    },
  };
  const [flow, version] = await Promise.all([
    Flow.exists({
      workspaceId,
      status: "active",
      deletedAt: null,
      "draft.nodes": nodeMatch,
    }),
    FlowVersion.exists({
      workspaceId,
      status: "active",
      nodes: nodeMatch,
    }),
  ]);
  return Boolean(flow || version);
}

function softDeleteMediaAsset({ workspaceId, mediaAssetId }) {
  return MediaAsset.findOneAndUpdate(
    { _id: mediaAssetId, workspaceId, status: { $ne: "deleted" } },
    { $set: { status: "deleted", deletedAt: new Date() } },
    { new: true }
  );
}

module.exports = {
  createMediaAsset,
  findMediaAssetById,
  getMediaAsset,
  isMediaAssetUsedByPublishedFlow,
  listMediaAssets,
  softDeleteMediaAsset,
  updateMediaAssetDisplayName,
};
