const crypto = require("crypto");
const os = require("os");
const path = require("path");
const fs = require("fs/promises");
const { GoogleGenAI } = require("@google/genai");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");

const MANAGED_FILE_SEARCH_ENABLED =
  String(process.env.AI_MANAGED_FILE_SEARCH_ENABLED || "true").toLowerCase() !== "false";
const MANAGED_FILE_SEARCH_EMBEDDING_MODEL = String(
  process.env.AI_MANAGED_FILE_SEARCH_EMBEDDING_MODEL || "models/gemini-embedding-2"
).trim();
const MANAGED_FILE_SEARCH_POLL_MS = Math.max(
  1000,
  Number(process.env.AI_MANAGED_FILE_SEARCH_POLL_MS || 3000) || 3000
);
const MANAGED_FILE_SEARCH_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.AI_MANAGED_FILE_SEARCH_TIMEOUT_MS || 180000) || 180000
);
const MANAGED_FILE_SEARCH_TOP_K = Math.max(
  1,
  Math.min(8, Number(process.env.AI_MANAGED_FILE_SEARCH_TOP_K || 4) || 4)
);
const FILE_SEARCH_MIN_TOKENS_PER_CHUNK = 120;
const FILE_SEARCH_MAX_TOKENS_PER_CHUNK = 512;
const FILE_SEARCH_DEFAULT_TOKENS_PER_CHUNK = 240;

let geminiClient = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGeminiApiKey() {
  return String(
    process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_AI_API_KEY ||
      ""
  ).trim();
}

function isEnabled() {
  return MANAGED_FILE_SEARCH_ENABLED && Boolean(getGeminiApiKey());
}

function getClient() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is not configured for managed File Search");
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

function buildStoreDisplayName({ agent }) {
  const agentName = String(agent?.name || "agent").trim().slice(0, 120);
  return `AI Agent KB - ${agentName}`;
}

function normalizeManagedConfig(agent) {
  const metadata = agent?.metadata || {};
  const managed = metadata?.managedFileSearch || {};
  return {
    enabled: Boolean(managed.enabled),
    storeName: String(managed.storeName || "").trim() || null,
    displayName: String(managed.displayName || "").trim() || null,
    embeddingModel:
      String(managed.embeddingModel || "").trim() || MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
    status: String(managed.status || "").trim() || "idle",
    lastError: String(managed.lastError || "").trim() || "",
    syncedAt: managed.syncedAt || null,
    documentCount: Number(managed.documentCount || 0),
  };
}

function resolveFileSearchTokensPerChunk(source) {
  const configured = Number(source?.metadata?.chunkSize || FILE_SEARCH_DEFAULT_TOKENS_PER_CHUNK);
  const value = Number.isFinite(configured) && configured > 0
    ? configured
    : FILE_SEARCH_DEFAULT_TOKENS_PER_CHUNK;
  return Math.max(
    FILE_SEARCH_MIN_TOKENS_PER_CHUNK,
    Math.min(FILE_SEARCH_MAX_TOKENS_PER_CHUNK, value)
  );
}

function buildDocumentDisplayName(source) {
  const title = String(source?.title || "knowledge-source").trim();
  return title.slice(0, 180) || "knowledge-source";
}

function sanitizeFileBody(source) {
  const title = String(source?.title || "").trim();
  const type = String(source?.type || "text").trim();
  const url = String(source?.sourceUrl || "").trim();
  const content = String(source?.content || "").trim();
  return [
    title ? `Title: ${title}` : "",
    type ? `Type: ${type}` : "",
    url ? `Source URL: ${url}` : "",
    "",
    content,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function writeTempSourceFile(source) {
  const hash = crypto
    .createHash("sha1")
    .update(`${String(source?._id || "")}:${String(source?.contentHash || "")}:${Date.now()}`)
    .digest("hex");
  const filePath = path.join(os.tmpdir(), `ai-kb-${hash}.txt`);
  await fs.writeFile(filePath, sanitizeFileBody(source), "utf8");
  return filePath;
}

function buildCustomMetadata(source) {
  return [
    { key: "workspace_id", stringValue: String(source.workspaceId) },
    { key: "agent_id", stringValue: String(source.agentId) },
    { key: "source_id", stringValue: String(source._id) },
    { key: "source_type", stringValue: String(source.type || "text") },
    { key: "source_title", stringValue: String(source.title || "").slice(0, 200) },
  ];
}

async function countSyncedDocuments({ workspaceId, agentId }) {
  const sources = await aiKnowledgeRepository.listSources({ workspaceId, agentId });
  return sources.filter((source) => String(source?.metadata?.fileSearchDocumentName || "").trim()).length;
}

async function waitForOperation(operation) {
  const client = getClient();
  let current = operation;
  const startedAt = Date.now();
  while (current && !current.done) {
    if (Date.now() - startedAt > MANAGED_FILE_SEARCH_TIMEOUT_MS) {
      throw new Error("Managed File Search operation timed out");
    }
    await sleep(MANAGED_FILE_SEARCH_POLL_MS);
    current = await client.operations.get({ operationName: current.name });
  }
  if (current?.error) {
    throw new Error(
      String(current.error?.message || current.error?.status || "Managed File Search operation failed")
    );
  }
  return current;
}

async function updateAgentManagedConfig({ workspaceId, agentId, patch = {} }) {
  return aiAgentRepository.update({
    workspaceId,
    agentId,
    updates: Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [`metadata.managedFileSearch.${key}`, value])
    ),
  });
}

async function ensureStore({ workspaceId, agent }) {
  if (!isEnabled()) return null;
  const client = getClient();
  const managed = normalizeManagedConfig(agent);
  if (managed.storeName) {
    try {
      const store = await client.fileSearchStores.get({ name: managed.storeName });
      await updateAgentManagedConfig({
        workspaceId,
        agentId: agent._id,
        patch: {
          enabled: true,
          storeName: store.name,
          displayName: store.displayName || managed.displayName || buildStoreDisplayName({ agent }),
          embeddingModel: store.embeddingModel || managed.embeddingModel || MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
          status: "ready",
          lastError: "",
          syncedAt: new Date(),
          documentCount: Number(store.activeDocumentsCount || managed.documentCount || 0),
        },
      }).catch(() => {});
      return store;
    } catch (error) {
      await updateAgentManagedConfig({
        workspaceId,
        agentId: agent._id,
        patch: {
          status: "recreating",
          lastError: String(error?.message || "Store lookup failed").slice(0, 1000),
        },
      }).catch(() => {});
    }
  }

  const created = await client.fileSearchStores.create({
    config: {
      displayName: buildStoreDisplayName({ agent }),
      embeddingModel: MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
    },
  });
  await updateAgentManagedConfig({
    workspaceId,
    agentId: agent._id,
    patch: {
      enabled: true,
      storeName: created.name,
      displayName: created.displayName || buildStoreDisplayName({ agent }),
      embeddingModel: created.embeddingModel || MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
      status: "ready",
      lastError: "",
      syncedAt: new Date(),
      documentCount: Number(created.activeDocumentsCount || 0),
    },
  }).catch(() => {});
  return created;
}

async function syncSource({ workspaceId, agent, source }) {
  if (!isEnabled() || !agent || !source || source.deletedAt) return null;
  const client = getClient();
  const store = await ensureStore({ workspaceId, agent });
  if (!store?.name) return null;

  const previousDocumentName = String(source.metadata?.fileSearchDocumentName || "").trim();
  if (previousDocumentName) {
    await client.fileSearchStores.documents.delete({ name: previousDocumentName }).catch(() => {});
  }

  const tempFilePath = await writeTempSourceFile(source);
  try {
    const operation = await client.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName: store.name,
      file: tempFilePath,
      config: {
        displayName: buildDocumentDisplayName(source),
        customMetadata: buildCustomMetadata(source),
        chunkingConfig: {
          whiteSpaceConfig: {
            maxTokensPerChunk: resolveFileSearchTokensPerChunk(source),
            maxOverlapTokens: 20,
          },
        },
      },
    });
    const completed = await waitForOperation(operation);
    const documentName = String(completed?.response?.documentName || "").trim() || null;
    await aiKnowledgeRepository.updateSource({
      workspaceId,
      agentId: source.agentId,
      sourceId: source._id,
      updates: {
        "metadata.fileSearchDocumentName": documentName,
        "metadata.fileSearchStoreName": store.name,
        "metadata.fileSearchSyncStatus": documentName ? "synced" : "pending",
        "metadata.fileSearchLastSyncedAt": new Date(),
        "metadata.fileSearchError": "",
      },
    }).catch(() => {});
    await updateAgentManagedConfig({
      workspaceId,
      agentId: agent._id,
      patch: {
        enabled: true,
        storeName: store.name,
        displayName: store.displayName || buildStoreDisplayName({ agent }),
        embeddingModel: store.embeddingModel || MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
        status: "ready",
        lastError: "",
        syncedAt: new Date(),
        documentCount: await countSyncedDocuments({ workspaceId, agentId: agent._id }),
      },
    }).catch(() => {});
    return {
      storeName: store.name,
      documentName,
      status: "synced",
    };
  } catch (error) {
    const message = String(error?.message || "Managed File Search sync failed").slice(0, 1000);
    await aiKnowledgeRepository.updateSource({
      workspaceId,
      agentId: source.agentId,
      sourceId: source._id,
      updates: {
        "metadata.fileSearchSyncStatus": "failed",
        "metadata.fileSearchLastSyncedAt": new Date(),
        "metadata.fileSearchError": message,
      },
    }).catch(() => {});
    await updateAgentManagedConfig({
      workspaceId,
      agentId: agent._id,
      patch: {
        enabled: true,
        storeName: store.name,
        displayName: store.displayName || buildStoreDisplayName({ agent }),
        embeddingModel: store.embeddingModel || MANAGED_FILE_SEARCH_EMBEDDING_MODEL,
        status: "degraded",
        lastError: message,
        syncedAt: new Date(),
        documentCount: await countSyncedDocuments({ workspaceId, agentId: agent._id }),
      },
    }).catch(() => {});
    throw error;
  } finally {
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

async function deleteSourceDocument({ workspaceId, agent, source }) {
  if (!isEnabled() || !agent || !source) return { deleted: false };
  const documentName = String(source.metadata?.fileSearchDocumentName || "").trim();
  if (!documentName) return { deleted: false };
  const client = getClient();
  await client.fileSearchStores.documents.delete({ name: documentName }).catch(() => {});
  await aiKnowledgeRepository.updateSource({
    workspaceId,
    agentId: source.agentId,
    sourceId: source._id,
    updates: {
      "metadata.fileSearchDocumentName": "",
      "metadata.fileSearchSyncStatus": "deleted",
      "metadata.fileSearchLastSyncedAt": new Date(),
      "metadata.fileSearchError": "",
    },
  }).catch(() => {});
  await updateAgentManagedConfig({
    workspaceId,
    agentId: agent._id,
    patch: {
      documentCount: await countSyncedDocuments({ workspaceId, agentId: agent._id }),
      syncedAt: new Date(),
      lastError: "",
    },
  }).catch(() => {});
  return { deleted: true };
}

async function cleanupStoreIfEmpty({ workspaceId, agent }) {
  if (!isEnabled() || !agent) return { deleted: false };
  const sources = await aiKnowledgeRepository.listSources({
    workspaceId,
    agentId: agent._id,
  });
  if (sources.length > 0) return { deleted: false };
  const managed = normalizeManagedConfig(agent);
  if (!managed.storeName) return { deleted: false };
  const client = getClient();
  await client.fileSearchStores.delete({ name: managed.storeName }).catch(() => {});
  await updateAgentManagedConfig({
    workspaceId,
    agentId: agent._id,
    patch: {
      enabled: false,
      storeName: "",
      displayName: "",
      embeddingModel: "",
      status: "idle",
      lastError: "",
      syncedAt: new Date(),
      documentCount: 0,
    },
  }).catch(() => {});
  return { deleted: true };
}

function getAgentStoreConfig(agent) {
  if (!isEnabled()) return null;
  const managed = normalizeManagedConfig(agent);
  if (!managed.enabled || !managed.storeName) return null;
  if (managed.documentCount <= 0) return null;
  return {
    storeName: managed.storeName,
    topK: MANAGED_FILE_SEARCH_TOP_K,
    enabled: managed.enabled !== false,
    status: managed.status,
  };
}

module.exports = {
  isEnabled,
  ensureStore,
  syncSource,
  deleteSourceDocument,
  cleanupStoreIfEmpty,
  getAgentStoreConfig,
  MANAGED_FILE_SEARCH_TOP_K,
};
