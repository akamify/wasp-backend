const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");

const MAX_CHUNK_CHARS = 900;
const MAX_SOURCE_CHUNKS = 8;

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\s]/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 80);
}

function chunkText(text, size = MAX_CHUNK_CHARS) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const chunks = [];
  for (let index = 0; index < normalized.length && chunks.length < MAX_SOURCE_CHUNKS; index += size) {
    chunks.push(normalized.slice(index, index + size).trim());
  }
  return chunks.filter(Boolean);
}

function buildKnowledgeChunks(agent) {
  const sources = Array.isArray(agent?.knowledgeSources) ? agent.knowledgeSources : [];
  return sources.flatMap((source, sourceIndex) => {
    const content = [source.title, source.content, source.url].filter(Boolean).join("\n");
    return chunkText(content).map((text, chunkIndex) => ({
      id: `${source._id || sourceIndex}:${chunkIndex}`,
      sourceId: source._id ? String(source._id) : null,
      title: source.title || source.type || "Knowledge",
      type: source.type || "text",
      url: source.url || "",
      text,
    }));
  });
}

function scoreChunk(chunk, queryTokens, query = "") {
  if (!queryTokens.length) return 0;
  const normalizedQuery = String(query || "").toLowerCase().trim();
  const title = String(chunk.title || chunk.metadata?.sourceTitle || "").toLowerCase();
  const text = String(chunk.text || chunk.chunkText || "").toLowerCase();
  const searchBoost = Math.min(10, Math.max(0, Number(chunk.searchBoost || chunk.metadata?.searchBoost || 1) || 1));
  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 8;
  if (normalizedQuery && text.includes(normalizedQuery)) score += 5;
  for (const token of queryTokens) {
    if (title.includes(token)) score += 5;
    if (text.includes(token)) score += token.length > 5 ? 2 : 1;
  }
  return Number((score * searchBoost).toFixed(2));
}

function normalizeLegacyChunk(chunk) {
  return {
    id: chunk.id,
    chunkId: chunk.id,
    sourceId: chunk.sourceId || null,
    title: chunk.title,
    type: chunk.type,
    url: chunk.url,
    text: chunk.text,
    score: Number(chunk.score || 0),
    searchBoost: Number(chunk.searchBoost || 1),
    legacy: true,
  };
}

function normalizeDbChunk(chunk, score = 0) {
  return {
    id: String(chunk._id),
    chunkId: String(chunk._id),
    sourceId: String(chunk.sourceId),
    title: chunk.metadata?.sourceTitle || "Knowledge",
    type: chunk.metadata?.sourceType || "text",
    url: chunk.metadata?.sourceUrl || "",
    text: chunk.chunkText,
    score,
    searchBoost: Number(chunk.metadata?.searchBoost || 1),
    legacy: false,
  };
}

function searchLegacyKnowledge({ agent, query, limit = 5 }) {
  const chunks = buildKnowledgeChunks(agent);
  const queryTokens = tokenize(query);
  const ranked = chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(chunk, queryTokens, query) }))
    .filter((chunk) => chunk.score > 0 || chunks.length <= limit)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(normalizeLegacyChunk);
  return ranked;
}

async function searchKnowledge({ workspaceId, agentId, agent, query, limit = 5 }) {
  const queryTokens = tokenize(query);
  if (workspaceId && agentId) {
    const chunks = await aiKnowledgeRepository.listChunksForAgent({ workspaceId, agentId, limit: 500 });
    const ranked = chunks
      .map((chunk) => normalizeDbChunk(chunk, scoreChunk(chunk, queryTokens, query)))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (ranked.length) return ranked;
  }
  return searchLegacyKnowledge({ agent, query, limit });
}

async function hasIndexedKnowledge({ workspaceId, agentId, agent }) {
  if (workspaceId && agentId) {
    const chunks = await aiKnowledgeRepository.listChunksForAgent({ workspaceId, agentId, limit: 1 });
    if (chunks.length > 0) return true;
  }
  return Array.isArray(agent?.knowledgeSources) && agent.knowledgeSources.length > 0;
}

function formatKnowledgeChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return "No relevant knowledge found for this message.";
  return chunks
    .map((chunk, index) => {
      const lines = [
        `Source ${index + 1}: ${chunk.title}`,
        chunk.url ? `URL: ${chunk.url}` : "",
        `Content: ${chunk.text}`,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

module.exports = {
  searchKnowledge,
  searchLegacyKnowledge,
  hasIndexedKnowledge,
  formatKnowledgeChunks,
};
