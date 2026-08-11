const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const aiKnowledgeRepository = require("@modules/ai-agents/repositories/aiKnowledge.repository");
const aiKnowledgeIndexer = require("@modules/ai-agents/services/aiKnowledgeIndexer.service");
const aiKnowledgeExtraction = require("@modules/ai-agents/services/aiKnowledgeExtraction.service");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");
const { assertStorageQuotaAvailable } = require("@modules/billing/services/workspaceQuota.service");

const KB_MAX_URL_SOURCES_PER_AGENT = Number(process.env.AI_KB_MAX_URL_SOURCES_PER_AGENT || 25);
const KB_MAX_TITLE_DUPLICATES_PER_AGENT = Number(process.env.AI_KB_MAX_TITLE_DUPLICATES_PER_AGENT || 5);

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
    metadata: {
      ...(value.metadata || {}),
      duplicateOfSourceId: value.metadata?.duplicateOfSourceId ? String(value.metadata.duplicateOfSourceId) : null,
    },
  };
}

async function normalizePayload(payload = {}, { existing = null } = {}) {
  const type = String(payload.type || "text").trim();
  const title = String(payload.title || "").trim();
  const sourceUrl = String(payload.sourceUrl || payload.url || "").trim();
  const question = String(payload.question || payload.metadata?.question || "").trim();
  const answer = String(payload.answer || payload.metadata?.answer || "").trim();
  const content = String(payload.content || "").trim();
  const searchBoost = Math.min(10, Math.max(0, Number(payload.searchBoost ?? payload.metadata?.searchBoost ?? existing?.metadata?.searchBoost ?? 1) || 1));
  const chunkSize = Math.min(2000, Math.max(100, Number(payload.chunkSize ?? payload.metadata?.chunkSize ?? existing?.metadata?.chunkSize ?? 900) || 900));
  const maxChunks = Math.min(1000, Math.max(1, Number(payload.maxChunks ?? payload.metadata?.maxChunks ?? existing?.metadata?.maxChunks ?? 500) || 500));
  const crawlPages = Math.max(1, Number(payload.crawlPages ?? payload.metadata?.crawlPages ?? existing?.metadata?.crawlPages ?? 1) || 1);
  const crawlDepth = Math.max(0, Number(payload.crawlDepth ?? payload.metadata?.crawlDepth ?? existing?.metadata?.crawlDepth ?? 0) || 0);

  if (!["faq", "text", "url", "pdf", "docx", "csv", "txt"].includes(type)) throw new HttpError(400, "Unsupported knowledge source type");
  if (!title && type !== "faq") throw new HttpError(400, "Title is required");
  if (type === "faq" && (!question || !answer)) throw new HttpError(400, "FAQ question and answer are required");
  if (type === "text" && !content) throw new HttpError(400, "Text content is required");
  if (["pdf", "docx", "csv", "txt"].includes(type) && !content) throw new HttpError(400, "File source content is required");
  if (type === "url" && (crawlPages > 1 || crawlDepth > 0)) throw new HttpError(400, "URL knowledge currently supports only single-page crawl with depth 0.");

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
      searchBoost,
      chunkSize,
      maxChunks,
      crawlPages,
      crawlDepth,
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
      duplicateSource: serializeSource(duplicate),
    });
  }
  return hash;
}

async function getKnowledgePolicy({ workspaceId, agentId }) {
  const [usage, addonStatus, sources] = await Promise.all([
    aiKnowledgeRepository.workspaceUsageSummary({ workspaceId }),
    aiAddonService.getAddonStatus({ workspaceId }),
    aiKnowledgeRepository.listSources({ workspaceId, agentId }),
  ]);
  const workspaceBytes = Number(usage.totalBytes || 0);
  const workspaceQuotaMb = Math.max(0, Number(addonStatus?.workspace?.limits?.maxKbStorageMb || addonStatus?.catalog?.limits?.maxKbStorageMb || 0));
  const workspaceQuotaBytes = workspaceQuotaMb > 0 ? workspaceQuotaMb * 1024 * 1024 : 0;
  const duplicateTitles = {};
  for (const source of sources) {
    const key = String(source.title || "").trim().toLowerCase();
    if (!key) continue;
    duplicateTitles[key] = Number(duplicateTitles[key] || 0) + 1;
  }
  return {
    quota: {
      workspaceUsedBytes: workspaceBytes,
      workspaceUsedMb: Number((workspaceBytes / (1024 * 1024)).toFixed(2)),
      workspaceQuotaBytes,
      workspaceQuotaMb,
      workspaceRemainingBytes: Math.max(0, workspaceQuotaBytes - workspaceBytes),
      workspaceRemainingMb: Number((Math.max(0, workspaceQuotaBytes - workspaceBytes) / (1024 * 1024)).toFixed(2)),
    },
    policy: {
      maxUploadBytes: aiKnowledgeExtraction.PRODUCT_FILE_SIZE_LIMIT_BYTES,
      supportedMimeTypes: aiKnowledgeExtraction.SUPPORTED_UPLOAD_TYPES,
      maxWebsiteBytes: aiKnowledgeExtraction.WEBSITE_MAX_BYTES,
      maxExtractedChars: aiKnowledgeExtraction.MAX_EXTRACTED_CHARS,
      crawlPagesAllowed: 1,
      crawlDepthAllowed: 0,
      maxUrlSourcesPerAgent: KB_MAX_URL_SOURCES_PER_AGENT,
      maxTitleDuplicatesPerAgent: KB_MAX_TITLE_DUPLICATES_PER_AGENT,
      chunking: {
        minChunkSize: 100,
        maxChunkSize: 2000,
        maxChunksPerSource: 1000,
        defaultChunkSize: 900,
        defaultMaxChunks: 500,
      },
      ranking: {
        minSearchBoost: 0,
        maxSearchBoost: 10,
        defaultSearchBoost: 1,
      },
    },
    duplicates: {
      duplicateTitles,
    },
  };
}

async function assertWorkspaceQuota({ workspaceId, agentId, nextContent, nextSizeBytes = 0, sourceId = null }) {
  const { quota } = await getKnowledgePolicy({ workspaceId, agentId });
  if (!quota.workspaceQuotaBytes) return;
  const existing = sourceId
    ? await aiKnowledgeRepository.findSourceById({ workspaceId, agentId, sourceId })
    : null;
  const existingBytes = existing
    ? Math.max(
        Number(existing.metadata?.sizeBytes || 0),
        Buffer.byteLength(String(existing.content || ""), "utf8")
      )
    : 0;
  const candidateBytes = Math.max(Number(nextSizeBytes || 0), Buffer.byteLength(String(nextContent || ""), "utf8"));
  const projectedBytes = Number(quota.workspaceUsedBytes || 0) - existingBytes + candidateBytes;
  if (projectedBytes > quota.workspaceQuotaBytes) {
    throw new HttpError(400, `Knowledge storage quota exceeded. Workspace limit is ${quota.workspaceQuotaMb} MB.`, {
      workspaceQuotaMb: quota.workspaceQuotaMb,
      workspaceUsedMb: quota.workspaceUsedMb,
      projectedMb: Number((projectedBytes / (1024 * 1024)).toFixed(2)),
    });
  }
}

async function assertUrlSourcePolicy({ workspaceId, agentId, type, sourceId = null }) {
  if (type !== "url") return;
  const sources = await aiKnowledgeRepository.listSources({ workspaceId, agentId });
  const urlCount = sources.filter((item) => item.type === "url" && String(item._id) !== String(sourceId || "")).length;
  if (urlCount >= KB_MAX_URL_SOURCES_PER_AGENT) {
    throw new HttpError(400, `URL knowledge limit reached for this agent. Maximum ${KB_MAX_URL_SOURCES_PER_AGENT} URL sources allowed.`);
  }
}

async function buildDuplicateSignals({ workspaceId, agentId, currentSourceId = null }) {
  const sources = await aiKnowledgeRepository.listSources({ workspaceId, agentId });
  const titleGroups = new Map();
  for (const source of sources) {
    const key = String(source.title || "").trim().toLowerCase();
    if (!key) continue;
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(source);
  }
  const duplicates = [];
  for (const group of titleGroups.values()) {
    if (group.length <= 1) continue;
    duplicates.push(
      ...group.map((item) => ({
        sourceId: String(item._id),
        title: item.title,
        duplicateCount: group.length,
        current: String(item._id) === String(currentSourceId || ""),
      }))
    );
  }
  return duplicates;
}

async function listSources({ workspaceId, agentId }) {
  await requireAgent({ workspaceId, agentId });
  const sources = await aiKnowledgeRepository.listSources({ workspaceId, agentId });
  const policy = await getKnowledgePolicy({ workspaceId, agentId });
  return { success: true, sources: sources.map(serializeSource), ...policy };
}

async function createSource({ workspaceId, agentId, actorId, payload }) {
  await requireAgent({ workspaceId, agentId });
  const normalized = await normalizePayload(payload);
  await assertUrlSourcePolicy({ workspaceId, agentId, type: normalized.type });
  if (Number(normalized.metadata?.sizeBytes || 0) > 0) {
    await assertStorageQuotaAvailable({
      workspaceId,
      incomingBytes: Number(normalized.metadata?.sizeBytes || 0),
    });
  }
  await assertWorkspaceQuota({
    workspaceId,
    agentId,
    nextContent: normalized.content,
    nextSizeBytes: normalized.metadata?.sizeBytes || 0,
  });
  const hash = await assertNotDuplicate({ workspaceId, agentId, content: normalized.content });
  const titleDuplicates = await buildDuplicateSignals({ workspaceId, agentId });
  const sameTitleCount = titleDuplicates.filter((item) => String(item.title || "").trim().toLowerCase() === String(normalized.title || "").trim().toLowerCase()).length;
  if (sameTitleCount >= KB_MAX_TITLE_DUPLICATES_PER_AGENT) {
    throw new HttpError(400, `Too many sources already use this title. Maximum ${KB_MAX_TITLE_DUPLICATES_PER_AGENT} duplicate titles allowed per agent.`);
  }
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
  await assertUrlSourcePolicy({ workspaceId, agentId, type: normalized.type, sourceId });
  if (Number(normalized.metadata?.sizeBytes || 0) > 0) {
    await assertStorageQuotaAvailable({
      workspaceId,
      incomingBytes: Number(normalized.metadata?.sizeBytes || 0),
      excludedBytes: Number(existing.metadata?.sizeBytes || 0),
    });
  }
  await assertWorkspaceQuota({
    workspaceId,
    agentId,
    nextContent: normalized.content,
    nextSizeBytes: normalized.metadata?.sizeBytes || existing.metadata?.sizeBytes || 0,
    sourceId,
  });
  const hash = await assertNotDuplicate({ workspaceId, agentId, content: normalized.content, sourceId });
  const source = await aiKnowledgeRepository.updateSource({
    workspaceId,
    agentId,
    sourceId,
    updates: {
      type: normalized.type,
      title: normalized.title,
      content: normalized.content,
      sourceUrl: normalized.sourceUrl,
      metadata: normalized.metadata,
      status: "draft",
      contentHash: hash,
      "metadata.totalChunks": 0,
      "metadata.lastIndexedAt": null,
      "metadata.error": "",
      updatedBy: actorId || null,
    },
  });
  const indexed = await aiKnowledgeIndexer.indexSource({ workspaceId, agentId, sourceId: source._id });
  return { success: true, source: serializeSource(indexed || source) };
}

async function uploadFileSource({ workspaceId, agentId, actorId, file }) {
  await requireAgent({ workspaceId, agentId });
  const extracted = await aiKnowledgeExtraction.extractFile(file);
  await assertStorageQuotaAvailable({
    workspaceId,
    incomingBytes: Number(extracted.metadata?.sizeBytes || 0),
  });
  await assertWorkspaceQuota({
    workspaceId,
    agentId,
    nextContent: extracted.content,
    nextSizeBytes: extracted.metadata?.sizeBytes || 0,
  });
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
  getKnowledgePolicy,
};
