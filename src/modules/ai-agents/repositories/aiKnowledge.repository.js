const { KnowledgeSource } = require("@infra/database/KnowledgeSource");
const { KnowledgeChunk } = require("@infra/database/KnowledgeChunk");

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeSourceUpdates(updates = {}) {
  if (!isPlainObject(updates)) return updates;
  const normalized = { ...updates };
  const metadata = normalized.metadata;
  if (!isPlainObject(metadata)) return normalized;

  for (const [key, value] of Object.entries(metadata)) {
    const dottedKey = `metadata.${key}`;
    if (!Object.prototype.hasOwnProperty.call(normalized, dottedKey)) {
      normalized[dottedKey] = value;
    }
  }
  delete normalized.metadata;
  return normalized;
}

function listSources({ workspaceId, agentId }) {
  return KnowledgeSource.find({ workspaceId, agentId, deletedAt: null })
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
}

function listWorkspaceSources({ workspaceId }) {
  return KnowledgeSource.find({ workspaceId, deletedAt: null }).sort({ updatedAt: -1, _id: -1 }).lean();
}

function findSourceById({ workspaceId, agentId, sourceId }) {
  return KnowledgeSource.findOne({ _id: sourceId, workspaceId, agentId, deletedAt: null });
}

function createSource(payload) {
  return KnowledgeSource.create(payload);
}

function findSourceByHash({ workspaceId, agentId, contentHash, excludeSourceId = null }) {
  if (!contentHash) return null;
  return KnowledgeSource.findOne({
    workspaceId,
    agentId,
    contentHash,
    deletedAt: null,
    ...(excludeSourceId ? { _id: { $ne: excludeSourceId } } : {}),
  });
}

function updateSource({ workspaceId, agentId, sourceId, updates }) {
  const normalizedUpdates = normalizeSourceUpdates(updates);
  return KnowledgeSource.findOneAndUpdate(
    { _id: sourceId, workspaceId, agentId, deletedAt: null },
    { $set: normalizedUpdates },
    { returnDocument: "after", runValidators: true },
  );
}

function softDeleteSource({ workspaceId, agentId, sourceId, actorId, now }) {
  return KnowledgeSource.findOneAndUpdate(
    { _id: sourceId, workspaceId, agentId, deletedAt: null },
    {
      $set: {
        deletedAt: now,
        updatedBy: actorId || null,
      },
    },
    { returnDocument: "after", runValidators: true },
  );
}

function deleteChunksForSource({ workspaceId, agentId, sourceId }) {
  return KnowledgeChunk.deleteMany({ workspaceId, agentId, sourceId });
}

function createChunks(chunks) {
  if (!chunks.length) return [];
  return KnowledgeChunk.insertMany(chunks, { ordered: true });
}

function countChunks({ workspaceId, agentId, sourceId }) {
  return KnowledgeChunk.countDocuments({ workspaceId, agentId, sourceId, deletedAt: null });
}

function searchChunks({ workspaceId, agentId, limit = 5 }) {
  return KnowledgeChunk.find({ workspaceId, agentId, deletedAt: null })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(300)
    .lean()
    .then((chunks) => chunks.slice(0, Math.max(1, Math.min(Number(limit || 5), 10))));
}

function listChunksForAgent({ workspaceId, agentId, limit = 500 }) {
  return KnowledgeChunk.find({ workspaceId, agentId, deletedAt: null })
    .sort({ updatedAt: -1, _id: -1 })
    .limit(limit)
    .lean();
}

async function workspaceUsageSummary({ workspaceId }) {
  const rows = await KnowledgeSource.aggregate([
    { $match: { workspaceId, deletedAt: null } },
    {
      $group: {
        _id: null,
        totalSources: { $sum: 1 },
        totalChunks: { $sum: { $ifNull: ["$metadata.totalChunks", 0] } },
        totalBytes: {
          $sum: {
            $cond: [
              { $gt: [{ $ifNull: ["$metadata.sizeBytes", 0] }, 0] },
              { $ifNull: ["$metadata.sizeBytes", 0] },
              { $strLenCP: { $ifNull: ["$content", ""] } },
            ],
          },
        },
        urlSources: {
          $sum: { $cond: [{ $eq: ["$type", "url"] }, 1, 0] },
        },
      },
    },
  ]);
  return rows[0] || { totalSources: 0, totalChunks: 0, totalBytes: 0, urlSources: 0 };
}

module.exports = {
  listSources,
  listWorkspaceSources,
  findSourceById,
  createSource,
  findSourceByHash,
  updateSource,
  softDeleteSource,
  deleteChunksForSource,
  createChunks,
  countChunks,
  searchChunks,
  listChunksForAgent,
  workspaceUsageSummary,
};
