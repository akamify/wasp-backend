const aiAgentsService = require("@modules/ai-agents/services/aiAgents.service");
const aiRuntimeService = require("@modules/ai-agents/services/aiRuntime.service");
const aiKnowledgeSourcesService = require("@modules/ai-agents/services/aiKnowledgeSources.service");

async function listAgents(req, res) {
  res.json(
    await aiAgentsService.listAgents({
      workspaceId: req.workspace.id,
      query: req.query,
    }),
  );
}

async function getAgent(req, res) {
  res.json(
    await aiAgentsService.getAgent({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
    }),
  );
}

async function createAgent(req, res) {
  res.status(201).json(
    await aiAgentsService.createAgent({
      workspaceId: req.workspace.id,
      actorId: req.user?.id,
      payload: req.body,
    }),
  );
}

async function updateAgent(req, res) {
  res.json(
    await aiAgentsService.updateAgent({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      actorId: req.user?.id,
      payload: req.body,
    }),
  );
}

async function deleteAgent(req, res) {
  res.json(
    await aiAgentsService.deleteAgent({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      actorId: req.user?.id,
    }),
  );
}

async function testMessage(req, res) {
  res.json(
    await aiRuntimeService.testMessage({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      payload: req.body,
    }),
  );
}

async function listConversations(req, res) {
  res.json(
    await aiRuntimeService.listConversations({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
    }),
  );
}

async function clearTestMemory(req, res) {
  res.json(
    await aiRuntimeService.clearTestMemory({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      payload: req.body,
    }),
  );
}

async function listKnowledge(req, res) {
  res.json(
    await aiKnowledgeSourcesService.listSources({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
    }),
  );
}

async function createKnowledge(req, res) {
  res.status(201).json(
    await aiKnowledgeSourcesService.createSource({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      actorId: req.user?.id,
      payload: req.body,
    }),
  );
}

async function uploadKnowledge(req, res) {
  res.status(201).json(
    await aiKnowledgeSourcesService.uploadFileSource({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      actorId: req.user?.id,
      file: req.file,
    }),
  );
}

async function updateKnowledge(req, res) {
  res.json(
    await aiKnowledgeSourcesService.updateSource({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      sourceId: req.params.sourceId,
      actorId: req.user?.id,
      payload: req.body,
    }),
  );
}

async function deleteKnowledge(req, res) {
  res.json(
    await aiKnowledgeSourcesService.deleteSource({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      sourceId: req.params.sourceId,
      actorId: req.user?.id,
    }),
  );
}

async function reindexKnowledge(req, res) {
  res.json(
    await aiKnowledgeSourcesService.reindexSource({
      workspaceId: req.workspace.id,
      agentId: req.params.agentId,
      sourceId: req.params.sourceId,
    }),
  );
}

module.exports = {
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  testMessage,
  listConversations,
  clearTestMemory,
  listKnowledge,
  createKnowledge,
  uploadKnowledge,
  updateKnowledge,
  deleteKnowledge,
  reindexKnowledge,
};
