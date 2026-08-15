const crypto = require("crypto");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const aiEmbeddingService = require("@modules/ai-agents/services/aiEmbedding.service");
const aiManagedFileSearchService = require("@modules/ai-agents/services/aiManagedFileSearch.service");

const MIN_CHUNK_CHARS = 40;
const MAX_CHUNK_CHARS = 900;
const ABSOLUTE_MAX_CHUNK_CHARS = 2000;
const ABSOLUTE_MAX_SOURCE_CHUNKS = 1000;

function cleanText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function contentHash(value) {
  return crypto
    .createHash("sha256")
    .update(cleanText(value).toLowerCase())
    .digest("hex");
}

function extractSourceText(source) {
  if (source.type === "faq") {
    const question = source.metadata?.question || source.title;
    const answer = source.metadata?.answer || source.content;
    return cleanText([`Question: ${question}`, `Answer: ${answer}`].filter(Boolean).join("\n"));
  }
  if (source.type === "url") {
    return cleanText([source.title, source.sourceUrl ? `URL: ${source.sourceUrl}` : "", source.content].filter(Boolean).join("\n"));
  }
  return cleanText([source.title, source.content].filter(Boolean).join("\n"));
}

function splitIntoSentences(text) {
  return cleanText(text)
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitChunks(text, options = {}) {
  const chunkSize = Math.min(
    ABSOLUTE_MAX_CHUNK_CHARS,
    Math.max(MIN_CHUNK_CHARS, Number(options.chunkSize || MAX_CHUNK_CHARS) || MAX_CHUNK_CHARS)
  );
  const maxChunks = Math.min(
    ABSOLUTE_MAX_SOURCE_CHUNKS,
    Math.max(1, Number(options.maxChunks || 500) || 500)
  );
  const sentences = splitIntoSentences(text);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > chunkSize && current.length >= MIN_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks
    .flatMap((chunk) => {
      if (chunk.length <= chunkSize + 200) return [chunk];
      const parts = [];
      for (let index = 0; index < chunk.length; index += chunkSize) {
        parts.push(chunk.slice(index, index + chunkSize).trim());
      }
      return parts;
    })
    .filter((chunk) => chunk.length >= MIN_CHUNK_CHARS)
    .slice(0, maxChunks);
}

async function indexSource({ workspaceId, agentId, sourceId }) {
  const source = await aiKnowledgeRepository.findSourceById({ workspaceId, agentId, sourceId });
  if (!source) return null;
  await aiKnowledgeRepository.updateSource({
    workspaceId,
    agentId,
    sourceId,
    updates: { status: "indexing", "metadata.error": "" },
  });
  try {
    const text = extractSourceText(source);
    const sourceHash = contentHash(text);
    const chunkSize = Number(source.metadata?.chunkSize || MAX_CHUNK_CHARS);
    const maxChunks = Number(source.metadata?.maxChunks || 500);
    const chunkTexts = splitChunks(text, { chunkSize, maxChunks });
    if (!chunkTexts.length) {
      throw new Error("Knowledge source has no indexable content");
    }
    let embeddings = [];
    let embeddingError = "";
    if (aiEmbeddingService.isConfigured()) {
      try {
        embeddings = await aiEmbeddingService.embedDocuments(
          chunkTexts.map((chunkText) => ({
            title: source.title,
            text: chunkText,
          }))
        );
      } catch (error) {
        embeddingError = String(error?.message || "Embedding generation failed").slice(0, 1000);
        console.warn("[ai-knowledge] embedding generation failed", {
          workspaceId: String(workspaceId),
          agentId: String(agentId),
          sourceId: String(sourceId),
          error: embeddingError,
        });
      }
    }
    await aiKnowledgeRepository.deleteChunksForSource({ workspaceId, agentId, sourceId });
    await aiKnowledgeRepository.createChunks(
      chunkTexts.map((chunkText, chunkIndex) => ({
        workspaceId,
        agentId,
        sourceId,
        chunkText,
        contentHash: contentHash(chunkText),
        chunkIndex,
        metadata: {
          sourceTitle: source.title,
          sourceType: source.type,
          sourceUrl: source.sourceUrl || "",
          sectionKey: String(source.metadata?.sectionKey || ""),
          sectionLabel: String(source.metadata?.sectionLabel || ""),
          searchBoost: Number(source.metadata?.searchBoost || 1),
          chunkSize,
          maxChunks,
          embeddingModel:
            embeddings[chunkIndex]?.length > 0 ? aiEmbeddingService.DEFAULT_EMBEDDING_MODEL : "",
          embeddingDimensions: Number(embeddings[chunkIndex]?.length || 0),
        },
        embedding: Array.isArray(embeddings[chunkIndex]) ? embeddings[chunkIndex] : [],
      })),
    );
    const indexedSource = await aiKnowledgeRepository.updateSource({
      workspaceId,
      agentId,
      sourceId,
      updates: {
        status: "indexed",
        contentHash: sourceHash,
        "metadata.totalChunks": chunkTexts.length,
        "metadata.lastIndexedAt": new Date(),
        "metadata.embeddingModel":
          embeddings.some((item) => Array.isArray(item) && item.length > 0)
            ? aiEmbeddingService.DEFAULT_EMBEDDING_MODEL
            : "",
        "metadata.embeddingDimensions":
          Number(embeddings.find((item) => Array.isArray(item) && item.length > 0)?.length || 0),
        "metadata.lastEmbeddedAt":
          embeddings.some((item) => Array.isArray(item) && item.length > 0) ? new Date() : null,
        "metadata.embeddingError": embeddingError,
        "metadata.error": "",
      },
    });
    if (indexedSource && aiManagedFileSearchService.isEnabled()) {
      const agent = await aiAgentRepository.findById({ workspaceId, agentId });
      if (agent) {
        await aiManagedFileSearchService.syncSource({
          workspaceId,
          agent,
          source: indexedSource,
        }).catch((error) => {
          console.warn("[ai-knowledge] managed file search sync failed", {
            workspaceId: String(workspaceId),
            agentId: String(agentId),
            sourceId: String(sourceId),
            error: String(error?.message || "Managed File Search sync failed"),
          });
        });
      }
    }
    return indexedSource;
  } catch (error) {
    return aiKnowledgeRepository.updateSource({
      workspaceId,
      agentId,
      sourceId,
      updates: {
        status: "failed",
        "metadata.totalChunks": 0,
        "metadata.error": error?.message || "Indexing failed",
      },
    });
  }
}

module.exports = {
  cleanText,
  contentHash,
  splitChunks,
  indexSource,
};
