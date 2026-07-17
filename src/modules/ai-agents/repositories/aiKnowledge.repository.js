const { KnowledgeSource } = require("@infra/database/KnowledgeSource");
const { KnowledgeChunk } = require("@infra/database/KnowledgeChunk");

function listSources({ workspaceId, agentId }) {
  return KnowledgeSource.find({ workspaceId, agentId, deletedAt: null })
    .sort({ updatedAt: -1, _id: -1 })
    .lean();
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
  return KnowledgeSource.findOneAndUpdate(
    { _id: sourceId, workspaceId, agentId, deletedAt: null },
    { $set: updates },
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

module.exports = {
  listSources,
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
};
