const crypto = require("crypto");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");

const MIN_CHUNK_CHARS = 40;
const MAX_CHUNK_CHARS = 900;

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

function splitChunks(text) {
  const sentences = splitIntoSentences(text);
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > MAX_CHUNK_CHARS && current.length >= MIN_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks
    .flatMap((chunk) => {
      if (chunk.length <= MAX_CHUNK_CHARS + 200) return [chunk];
      const parts = [];
      for (let index = 0; index < chunk.length; index += MAX_CHUNK_CHARS) {
        parts.push(chunk.slice(index, index + MAX_CHUNK_CHARS).trim());
      }
      return parts;
    })
    .filter((chunk) => chunk.length >= MIN_CHUNK_CHARS)
    .slice(0, 500);
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
    const chunkTexts = splitChunks(text);
    if (!chunkTexts.length) {
      throw new Error("Knowledge source has no indexable content");
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
        },
      })),
    );
    return aiKnowledgeRepository.updateSource({
      workspaceId,
      agentId,
      sourceId,
      updates: {
        status: "indexed",
        contentHash: sourceHash,
        "metadata.totalChunks": chunkTexts.length,
        "metadata.lastIndexedAt": new Date(),
        "metadata.error": "",
      },
    });
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
