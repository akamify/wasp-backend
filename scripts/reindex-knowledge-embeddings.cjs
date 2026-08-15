require("../src/core/config/loadEnv").loadEnv();
require("module-alias/register");

const mongoose = require("mongoose");
const { connectDB } = require("@core/config/db");
const { mongoUri } = require("@core/config/env");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");
const aiKnowledgeIndexer = require("@modules/ai-agents/services/aiKnowledgeIndexer.service");

function asObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

async function main() {
  const workspaceId = asObjectId(process.argv[2] || "");
  const agentId = asObjectId(process.argv[3] || "");

  await connectDB(mongoUri);

  const sources = workspaceId
    ? await aiKnowledgeRepository.listWorkspaceSources({ workspaceId })
    : await require("@infra/database/KnowledgeSource").KnowledgeSource.find({
        deletedAt: null,
      }).lean();

  const filtered = sources.filter((source) => {
    if (workspaceId && String(source.workspaceId) !== String(workspaceId)) return false;
    if (agentId && String(source.agentId) !== String(agentId)) return false;
    return true;
  });

  console.info("[knowledge-reindex] starting", {
    totalSources: filtered.length,
    workspaceId: workspaceId ? String(workspaceId) : "all",
    agentId: agentId ? String(agentId) : "all",
  });

  let successCount = 0;
  let failureCount = 0;

  for (const source of filtered) {
    try {
      await aiKnowledgeIndexer.indexSource({
        workspaceId: source.workspaceId,
        agentId: source.agentId,
        sourceId: source._id,
      });
      successCount += 1;
      console.info("[knowledge-reindex] indexed", {
        workspaceId: String(source.workspaceId),
        agentId: String(source.agentId),
        sourceId: String(source._id),
        title: source.title,
      });
    } catch (error) {
      failureCount += 1;
      console.error("[knowledge-reindex] failed", {
        workspaceId: String(source.workspaceId),
        agentId: String(source.agentId),
        sourceId: String(source._id),
        title: source.title,
        error: error?.message || String(error),
      });
    }
  }

  console.info("[knowledge-reindex] finished", {
    successCount,
    failureCount,
  });

  await mongoose.connection.close();
}

main().catch(async (error) => {
  console.error("[knowledge-reindex] fatal", {
    error: error?.message || String(error),
    stack: error?.stack || null,
  });
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
