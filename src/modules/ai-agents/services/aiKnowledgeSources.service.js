const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");
const aiKnowledgeIndexer = require("@modules/ai-agents/services/aiKnowledgeIndexer.service");
const aiKnowledgeExtraction = require("@modules/ai-agents/services/aiKnowledgeExtraction.service");

function assertObjectId(value, label) {
  if (!mongoose.Types.ObjectId.isValid(String(value || ""))) {
    throw new HttpError(400, `Invalid ${label}`);
  }
}

async function requireAgent({ workspaceId, agentId }) {
  assertObjectId(agentId, "AI agent id");
  const agent = await aiAgentRepository.findById({ workspaceId, agentId });
  if (!agent) throw new HttpError(404, "AI agent not found");
  return agent;
}

function serializeSource(source) {
  const value = typeof source?.toObject === "function" ? source.toObject() : source;
  if (!value) return null;
  return {
    ...value,
    id: String(value._id),
    _id: String(value._id),
    workspaceId: String(value.workspaceId),
    agentId: String(value.agentId),
    createdBy: value.createdBy ? String(value.createdBy) : null,
    updatedBy: value.updatedBy ? String(value.updatedBy) : null,
  };
}

async function normalizePayload(payload = {}, { existing = null } = {}) {
  const type = String(payload.type || "text").trim();
  const title = String(payload.title || "").trim();
  const sourceUrl = String(payload.sourceUrl || payload.url || "").trim();
  const question = String(payload.question || payload.metadata?.question || "").trim();
  const answer = String(payload.answer || payload.metadata?.answer || "").trim();
  const content = String(payload.content || "").trim();

  if (!["faq", "text", "url", "pdf", "docx", "csv", "txt"].includes(type)) throw new HttpError(400, "Unsupported knowledge source type");
  if (!title && type !== "faq") throw new HttpError(400, "Title is required");
  if (type === "faq" && (!question || !answer)) throw new HttpError(400, "FAQ question and answer are required");
  if (type === "text" && !content) throw new HttpError(400, "Text content is required");
  if (["pdf", "docx", "csv", "txt"].includes(type) && !content) throw new HttpError(400, "File source content is required");

  let finalContent = content;
  let finalTitle = title || question;
  let finalSourceUrl = type === "url" ? sourceUrl : "";
  let extractionMetadata = {};
  if (type === "url") {
    if (!sourceUrl) throw new HttpError(400, "URL is required");
    if (!finalContent) {
      const fetched = await aiKnowledgeExtraction.fetchWebsiteText(sourceUrl);
      finalContent = fetched.content;
      finalTitle = finalTitle || fetched.title || sourceUrl;
      finalSourceUrl = fetched.sourceUrl;
      extractionMetadata = fetched.metadata || {};
    }
  }

  return {
    type,
    title: finalTitle,
    content: type === "faq" ? answer : finalContent,
    sourceUrl: finalSourceUrl,
    metadata: {
      ...(existing?.metadata?.toObject ? existing.metadata.toObject() : existing?.metadata || {}),
      question: type === "faq" ? question : "",
      answer: type === "faq" ? answer : "",
      ...extractionMetadata,
    },
  };
}

async function assertNotDuplicate({ workspaceId, agentId, content, sourceId = null }) {
  const hash = aiKnowledgeIndexer.contentHash(content);
  const duplicate = await aiKnowledgeRepository.findSourceByHash({
    workspaceId,
    agentId,
    contentHash: hash,
    excludeSourceId: sourceId,
  });
  if (duplicate) {
    throw new HttpError(409, "Duplicate knowledge source already exists", {
      duplicateSourceId: String(duplicate._id),
      title: duplicate.title,
    });
  }
  return hash;
}

async function listSources({ workspaceId, agentId }) {
  await requireAgent({ workspaceId, agentId });
  const sources = await aiKnowledgeRepository.listSources({ workspaceId, agentId });
  return { success: true, sources: sources.map(serializeSource) };
}

async function createSource({ workspaceId, agentId, actorId, payload }) {
  await requireAgent({ workspaceId, agentId });
  const normalized = await normalizePayload(payload);
  const hash = await assertNotDuplicate({ workspaceId, agentId, content: normalized.content });
  const source = await aiKnowledgeRepository.createSource({
    workspaceId,
    agentId,
    ...normalized,
    contentHash: hash,
    status: "draft",
    createdBy: actorId || null,
    updatedBy: actorId || null,
  });
  const indexed = await aiKnowledgeIndexer.indexSource({ workspaceId, agentId, sourceId: source._id });
  return { success: true, source: serializeSource(indexed || source) };
}

async function updateSource({ workspaceId, agentId, sourceId, actorId, payload }) {
  await requireAgent({ workspaceId, agentId });
  assertObjectId(sourceId, "knowledge source id");
  const existing = await aiKnowledgeRepository.findSourceById({ workspaceId, agentId, sourceId });
  if (!existing) throw new HttpError(404, "Knowledge source not found");
  const normalized = await normalizePayload({ ...existing.toObject(), ...payload }, { existing });
  const hash = await assertNotDuplicate({ workspaceId, agentId, content: normalized.content, sourceId });
  const source = await aiKnowledgeRepository.updateSource({
    workspaceId,
    agentId,
    sourceId,
    updates: {
      ...normalized,
      status: "draft",
      contentHash: hash,
      "metadata.totalChunks": 0,
      updatedBy: actorId || null,
    },
  });
  const indexed = await aiKnowledgeIndexer.indexSource({ workspaceId, agentId, sourceId: source._id });
  return { success: true, source: serializeSource(indexed || source) };
}

async function uploadFileSource({ workspaceId, agentId, actorId, file }) {
  await requireAgent({ workspaceId, agentId });
  const extracted = await aiKnowledgeExtraction.extractFile(file);
  const hash = await assertNotDuplicate({ workspaceId, agentId, content: extracted.content });
  const source = await aiKnowledgeRepository.createSource({
    workspaceId,
    agentId,
    type: extracted.type,
    title: extracted.title,
    content: extracted.content,
    sourceUrl: "",
    contentHash: hash,
    status: "draft",
    metadata: extracted.metadata || {},
    createdBy: actorId || null,
    updatedBy: actorId || null,
  });
  const indexed = await aiKnowledgeIndexer.indexSource({ workspaceId, agentId, sourceId: source._id });
  return { success: true, source: serializeSource(indexed || source) };
}

async function deleteSource({ workspaceId, agentId, sourceId, actorId }) {
  await requireAgent({ workspaceId, agentId });
  assertObjectId(sourceId, "knowledge source id");
  const now = new Date();
  const deleted = await aiKnowledgeRepository.softDeleteSource({ workspaceId, agentId, sourceId, actorId, now });
  if (!deleted) throw new HttpError(404, "Knowledge source not found");
  await aiKnowledgeRepository.deleteChunksForSource({ workspaceId, agentId, sourceId });
  return { success: true };
}

async function reindexSource({ workspaceId, agentId, sourceId }) {
  await requireAgent({ workspaceId, agentId });
  assertObjectId(sourceId, "knowledge source id");
  const source = await aiKnowledgeIndexer.indexSource({ workspaceId, agentId, sourceId });
  if (!source) throw new HttpError(404, "Knowledge source not found");
  return { success: true, source: serializeSource(source) };
}

module.exports = {
  listSources,
  createSource,
  uploadFileSource,
  updateSource,
  deleteSource,
  reindexSource,
  serializeSource,
};
