const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");
const aiEmbeddingService = require("@modules/ai-agents/services/aiEmbedding.service");

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
      sectionKey: String(source.metadata?.sectionKey || "").trim(),
      sectionLabel: String(source.metadata?.sectionLabel || "").trim(),
      searchBoost: Number(source.metadata?.searchBoost || 1),
      text,
    }));
  });
}

function scoreChunk(chunk, queryTokens, query = "") {
  if (!queryTokens.length) return 0;
  const normalizedQuery = String(query || "").toLowerCase().trim();
  const title = String(chunk.title || chunk.metadata?.sourceTitle || "").toLowerCase();
  const sectionText = `${String(chunk.sectionLabel || chunk.metadata?.sectionLabel || "").toLowerCase()} ${String(chunk.sectionKey || chunk.metadata?.sectionKey || "").toLowerCase()}`.trim();
  const text = String(chunk.text || chunk.chunkText || "").toLowerCase();
  const searchBoost = Math.min(10, Math.max(0, Number(chunk.searchBoost || chunk.metadata?.searchBoost || 1) || 1));
  let score = 0;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 8;
  if (normalizedQuery && sectionText.includes(normalizedQuery)) score += 6;
  if (normalizedQuery && text.includes(normalizedQuery)) score += 5;
  for (const token of queryTokens) {
    if (title.includes(token)) score += 5;
    if (sectionText.includes(token)) score += 3;
    if (text.includes(token)) score += token.length > 5 ? 2 : 1;
  }
  return Number((score * searchBoost).toFixed(2));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const valueA = Number(a[index] || 0);
    const valueB = Number(b[index] || 0);
    dot += valueA * valueB;
    magA += valueA * valueA;
    magB += valueB * valueB;
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function normalizeLegacyChunk(chunk) {
  return {
    id: chunk.id,
    chunkId: chunk.id,
    sourceId: chunk.sourceId || null,
    title: chunk.title,
    type: chunk.type,
    url: chunk.url,
    sectionKey: chunk.sectionKey || "",
    sectionLabel: chunk.sectionLabel || "",
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
    sectionKey: chunk.metadata?.sectionKey || "",
    sectionLabel: chunk.metadata?.sectionLabel || "",
    text: chunk.chunkText,
    score,
    searchBoost: Number(chunk.metadata?.searchBoost || 1),
    embedding: Array.isArray(chunk.embedding) ? chunk.embedding : [],
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
    const normalizedChunks = chunks.map((chunk) => normalizeDbChunk(chunk, scoreChunk(chunk, queryTokens, query)));
    const semanticCandidates = normalizedChunks.filter(
      (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0
    );
    if (semanticCandidates.length && aiEmbeddingService.isConfigured()) {
      try {
        const queryEmbedding = await aiEmbeddingService.embedQuery(query);
        const semanticRanked = semanticCandidates
          .map((chunk) => {
            const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
            const lexicalScore = Number(chunk.score || 0);
            const boostedSemantic = semanticScore * Math.max(0.1, Number(chunk.searchBoost || 1));
            const combinedScore = boostedSemantic * 100 + lexicalScore * 0.35;
            return {
              ...chunk,
              score: Number(combinedScore.toFixed(4)),
              semanticScore: Number(semanticScore.toFixed(4)),
              lexicalScore,
            };
          })
          .filter(
            (chunk) =>
              chunk.semanticScore >= Number(process.env.AI_SEMANTIC_MIN_SCORE || 0.18) ||
              chunk.lexicalScore > 0
          )
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (semanticRanked.length) return semanticRanked;
      } catch (error) {
        console.warn("[ai-knowledge] semantic retrieval fallback", {
          workspaceId: String(workspaceId),
          agentId: String(agentId),
          error: String(error?.message || "Semantic retrieval failed"),
        });
      }
    }
    const ranked = normalizedChunks
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

function fallbackSectionScore(chunk) {
  const sectionKey = String(chunk.sectionKey || chunk.metadata?.sectionKey || "").trim().toLowerCase();
  const sectionLabel = String(chunk.sectionLabel || chunk.metadata?.sectionLabel || "").trim().toLowerCase();
  const title = String(chunk.title || chunk.metadata?.sourceTitle || "").trim().toLowerCase();

  let score = 0;
  if (sectionKey === "business_profile") score += 20;
  else if (sectionKey === "services_products") score += 14;
  else if (sectionKey === "faq") score += 8;

  if (/business profile|about|company|brand/.test(sectionLabel)) score += 8;
  if (/service|product|offering/.test(sectionLabel)) score += 5;
  if (/about|company|business|service/.test(title)) score += 4;
  return score;
}

async function getKnowledgeMissFallbackChunks({ workspaceId, agentId, agent, limit = 3 }) {
  if (workspaceId && agentId) {
    const chunks = await aiKnowledgeRepository.listChunksForAgent({ workspaceId, agentId, limit: 500 });
    const ranked = chunks
      .map((chunk) => normalizeDbChunk(chunk, fallbackSectionScore(chunk)))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (ranked.length) return ranked;
  }

  const legacyRanked = buildKnowledgeChunks(agent)
    .map((chunk) => ({ ...chunk, score: fallbackSectionScore(chunk) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(normalizeLegacyChunk);
  return legacyRanked;
}

function formatKnowledgeChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) return "No relevant knowledge found for this message.";
  return chunks
    .slice(0, 4)
    .map((chunk, index) => {
      const lines = [
        `${index + 1}. ${chunk.sectionLabel ? `[${chunk.sectionLabel}] ` : ""}${chunk.title}`,
        chunk.url ? `Ref: ${String(chunk.url).slice(0, 120)}` : "",
        String(chunk.text || "").replace(/\s+/g, " ").slice(0, 220),
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

function summarizeKnowledgeSections(chunks) {
  const items = Array.isArray(chunks) ? chunks : [];
  const sections = [];
  for (const chunk of items) {
    const key = String(chunk.sectionKey || "").trim();
    const label = String(chunk.sectionLabel || "").trim();
    if (!key && !label) continue;
    const normalizedKey = key || label.toLowerCase().replace(/\s+/g, "_");
    if (sections.find((item) => item.key === normalizedKey)) continue;
    sections.push({
      key: normalizedKey,
      label: label || key,
    });
  }
  return sections;
}

module.exports = {
  searchKnowledge,
  searchLegacyKnowledge,
  hasIndexedKnowledge,
  getKnowledgeMissFallbackChunks,
  formatKnowledgeChunks,
  summarizeKnowledgeSections,
};
