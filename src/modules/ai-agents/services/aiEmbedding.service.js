const { GoogleGenAI } = require("@google/genai");

const DEFAULT_EMBEDDING_MODEL = String(
  process.env.AI_EMBEDDING_MODEL || "gemini-embedding-001"
).trim();
const DEFAULT_EMBEDDING_DIMENSION = Math.max(
  256,
  Math.min(3072, Number(process.env.AI_EMBEDDING_DIMENSION || 768) || 768)
);
const DEFAULT_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.AI_EMBEDDING_TIMEOUT_MS || 20000) || 20000
);
const DEFAULT_BATCH_SIZE = Math.max(
  1,
  Math.min(32, Number(process.env.AI_EMBEDDING_BATCH_SIZE || 12) || 12)
);

let geminiClient = null;

function getGeminiApiKey() {
  return String(
    process.env.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_AI_API_KEY ||
      ""
  ).trim();
}

function isConfigured() {
  return Boolean(getGeminiApiKey());
}

function getClient() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("Gemini embedding API key is not configured");
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

function isEmbedding2Model(model = DEFAULT_EMBEDDING_MODEL) {
  return /embedding-2/i.test(String(model || "").trim());
}

function sanitizeText(value) {
  return String(value || "")
    .replace(/\u0000/g, " ")
    .replace(/[\u0001-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function prepareDocumentText({ title, text }) {
  const safeTitle = sanitizeText(title) || "none";
  const safeText = sanitizeText(text);
  return `title: ${safeTitle} | text: ${safeText}`.slice(0, 6000);
}

function prepareQueryText(query) {
  return `task: search result | query: ${sanitizeText(query)}`.slice(0, 2000);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function extractEmbeddingValues(item) {
  if (Array.isArray(item)) return item.map(Number).filter(Number.isFinite);
  if (Array.isArray(item?.values)) return item.values.map(Number).filter(Number.isFinite);
  if (Array.isArray(item?.embedding?.values)) return item.embedding.values.map(Number).filter(Number.isFinite);
  return [];
}

async function runEmbedContent({ model, contents, config }) {
  const client = getClient();
  return Promise.race([
    client.models.embedContent({
      model,
      contents,
      config,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Gemini embedding timeout")), DEFAULT_TIMEOUT_MS)
    ),
  ]);
}

async function embedWithEmbedding001(texts, taskType) {
  const embeddings = [];
  for (const batch of chunkArray(texts, DEFAULT_BATCH_SIZE)) {
    const response = await runEmbedContent({
      model: DEFAULT_EMBEDDING_MODEL,
      contents: batch,
      config: {
        taskType,
        outputDimensionality: DEFAULT_EMBEDDING_DIMENSION,
      },
    });
    const values = Array.isArray(response?.embeddings)
      ? response.embeddings.map(extractEmbeddingValues)
      : [];
    embeddings.push(...values);
  }
  return embeddings;
}

async function embedWithEmbedding2(texts) {
  const embeddings = [];
  for (const text of texts) {
    const response = await runEmbedContent({
      model: DEFAULT_EMBEDDING_MODEL,
      contents: text,
      config: {
        outputDimensionality: DEFAULT_EMBEDDING_DIMENSION,
      },
    });
    const value =
      extractEmbeddingValues(Array.isArray(response?.embeddings) ? response.embeddings[0] : response?.embeddings) ||
      [];
    embeddings.push(value);
  }
  return embeddings;
}

async function embedDocuments(documents = []) {
  const prepared = documents
    .map((document) => prepareDocumentText(document))
    .filter(Boolean);
  if (!prepared.length) return [];
  if (isEmbedding2Model()) {
    return embedWithEmbedding2(prepared);
  }
  return embedWithEmbedding001(prepared, "RETRIEVAL_DOCUMENT");
}

async function embedQuery(query) {
  const safeQuery = sanitizeText(query);
  if (!safeQuery) return [];
  if (isEmbedding2Model()) {
    const [embedding] = await embedWithEmbedding2([prepareQueryText(safeQuery)]);
    return embedding || [];
  }
  const [embedding] = await embedWithEmbedding001([safeQuery], "RETRIEVAL_QUERY");
  return embedding || [];
}

module.exports = {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIMENSION,
  isConfigured,
  embedDocuments,
  embedQuery,
};