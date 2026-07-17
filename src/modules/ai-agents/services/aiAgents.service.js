const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const aiAgentRepository = require("@modules/ai-agents/repositories/aiAgent.repository");
const { slugifyAiAgent } = require("@modules/ai-agents/utils/slugifyAiAgent");

function assertValidAgentId(agentId) {
  if (!mongoose.Types.ObjectId.isValid(String(agentId || ""))) {
    throw new HttpError(400, "Invalid AI agent id");
  }
}

function parsePaging(query) {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 20), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeStringArray(values) {
  return Array.from(
    new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

function normalizeKnowledgeSources(values) {
  return (Array.isArray(values) ? values : [])
    .map((source) => ({
      type: source?.type || "text",
      title: String(source?.title || "").trim(),
      content: String(source?.content || "").trim(),
      url: String(source?.url || "").trim(),
      metadata: source?.metadata && typeof source.metadata === "object" ? source.metadata : {},
    }))
    .filter((source) => source.title || source.content || source.url)
    .slice(0, 25);
}

function normalizeTools(values) {
  return (Array.isArray(values) ? values : [])
    .map((tool) => ({
      type: String(tool?.type || "").trim(),
      enabled: tool?.enabled !== false,
      config: tool?.config && typeof tool.config === "object" ? tool.config : {},
    }))
    .filter((tool) => tool.type)
    .slice(0, 20);
}

function normalizeGuardrails(guardrails = {}) {
  return {
    ...(guardrails.fallbackMessage !== undefined
      ? { fallbackMessage: String(guardrails.fallbackMessage || "").trim() }
      : {}),
    ...(guardrails.handoverOnLowConfidence !== undefined
      ? { handoverOnLowConfidence: Boolean(guardrails.handoverOnLowConfidence) }
      : {}),
    ...(guardrails.maxMessagesPerSession !== undefined
      ? { maxMessagesPerSession: Math.min(500, Math.max(1, Number(guardrails.maxMessagesPerSession) || 50)) }
      : {}),
    ...(guardrails.allowedTopics !== undefined
      ? { allowedTopics: normalizeStringArray(guardrails.allowedTopics) }
      : {}),
    ...(guardrails.blockedTopics !== undefined
      ? { blockedTopics: normalizeStringArray(guardrails.blockedTopics) }
      : {}),
  };
}

function normalizePayload(payload, { partial = false } = {}) {
  const updates = {};
  const assign = (key, value) => {
    if (!partial || value !== undefined) updates[key] = value;
  };

  assign("name", payload.name !== undefined ? String(payload.name || "").trim() : undefined);
  assign("description", payload.description !== undefined ? String(payload.description || "").trim() : undefined);
  assign("status", payload.status || undefined);
  assign("persona", payload.persona || undefined);
  assign("modelProvider", payload.modelProvider || undefined);
  assign("modelName", payload.modelName !== undefined ? String(payload.modelName || "").trim() : undefined);
  assign("systemPrompt", payload.systemPrompt !== undefined ? String(payload.systemPrompt || "").trim() : undefined);
  assign("language", payload.language !== undefined ? String(payload.language || "auto").trim() || "auto" : undefined);
  assign("temperature", payload.temperature !== undefined ? Number(payload.temperature) : undefined);
  assign(
    "knowledgeSources",
    payload.knowledgeSources !== undefined ? normalizeKnowledgeSources(payload.knowledgeSources) : undefined,
  );
  assign("tools", payload.tools !== undefined ? normalizeTools(payload.tools) : undefined);
  assign("guardrails", payload.guardrails !== undefined ? normalizeGuardrails(payload.guardrails) : undefined);
  return updates;
}

async function uniqueSlug({ workspaceId, baseSlug, excludeId = null }) {
  const base = slugifyAiAgent(baseSlug);
  let candidate = base;
  for (let index = 2; index < 100; index += 1) {
    const existing = await aiAgentRepository.findBySlug({ workspaceId, slug: candidate });
    if (!existing || (excludeId && String(existing._id) === String(excludeId))) return candidate;
    candidate = `${base}-${index}`;
  }
  throw new HttpError(409, "Could not generate a unique AI agent slug");
}

function serializeAgent(agent) {
  if (!agent) return null;
  const value = typeof agent.toObject === "function" ? agent.toObject() : agent;
  return {
    ...value,
    id: String(value._id),
    _id: String(value._id),
    workspaceId: String(value.workspaceId),
  };
}

async function listAgents({ workspaceId, query }) {
  const { page, limit, skip } = parsePaging(query || {});
  const filter = {};
  if (query?.status) filter.status = query.status;
  const search = String(query?.search || "").trim();
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
      { slug: { $regex: search, $options: "i" } },
    ];
  }
  const [agents, total] = await Promise.all([
    aiAgentRepository.list({ workspaceId, filter, skip, limit }),
    aiAgentRepository.count({ workspaceId, filter }),
  ]);
  return {
    success: true,
    agents: agents.map(serializeAgent),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getAgent({ workspaceId, agentId }) {
  assertValidAgentId(agentId);
  const agent = await aiAgentRepository.findById({ workspaceId, agentId });
  if (!agent) throw new HttpError(404, "AI agent not found");
  return { success: true, agent: serializeAgent(agent) };
}

async function createAgent({ workspaceId, actorId, payload }) {
  const updates = normalizePayload(payload);
  const slug = await uniqueSlug({
    workspaceId,
    baseSlug: payload.slug || payload.name,
  });
  const agent = await aiAgentRepository.create({
    workspaceId,
    ...updates,
    slug,
    status: updates.status || "draft",
    createdBy: actorId || null,
    updatedBy: actorId || null,
  });
  return { success: true, agent: serializeAgent(agent) };
}

async function updateAgent({ workspaceId, agentId, actorId, payload }) {
  assertValidAgentId(agentId);
  const existing = await aiAgentRepository.findById({ workspaceId, agentId });
  if (!existing) throw new HttpError(404, "AI agent not found");
  const updates = normalizePayload(payload, { partial: true });
  if (payload.slug !== undefined || payload.name !== undefined) {
    updates.slug = await uniqueSlug({
      workspaceId,
      baseSlug: payload.slug || payload.name || existing.slug,
      excludeId: existing._id,
    });
  }
  updates.updatedBy = actorId || null;
  if (updates.status === "archived" && !existing.archivedAt) updates.archivedAt = new Date();
  const agent = await aiAgentRepository.update({ workspaceId, agentId, updates });
  return { success: true, agent: serializeAgent(agent) };
}

async function deleteAgent({ workspaceId, agentId, actorId }) {
  assertValidAgentId(agentId);
  const deleted = await aiAgentRepository.softDelete({
    workspaceId,
    agentId,
    actorId,
    now: new Date(),
  });
  if (!deleted) throw new HttpError(404, "AI agent not found");
  return { success: true };
}

module.exports = {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
};
