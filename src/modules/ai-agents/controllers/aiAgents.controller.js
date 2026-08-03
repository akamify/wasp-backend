const aiAgentsService = require("@modules/ai-agents/services/aiAgents.service");
const aiRuntimeService = require("@modules/ai-agents/services/aiRuntime.service");
const aiKnowledgeSourcesService = require("@modules/ai-agents/services/aiKnowledgeSources.service");
const aiAddonService = require("@modules/ai-agents/services/aiAddon.service");
const aiDashboardService = require("@modules/ai-agents/services/aiDashboard.service");
const aiBillingOperationsService = require("@modules/ai-agents/services/aiBillingOperations.service");

async function addonStatus(req, res) {
  res.json(
    await aiAddonService.getAddonStatus({
      workspaceId: req.workspace.id,
    })
  );
}

async function purchaseAddon(req, res) {
  res.status(201).json(
    await aiAddonService.purchaseAddon({
      workspaceId: req.workspace.id,
      userId: req.user?.id,
    })
  );
}

async function listAddonTransactions(req, res) {
  res.json(
    await aiAddonService.listCreditTransactions({
      workspaceId: req.workspace.id,
      limit: req.query.limit,
      cursor: req.query.cursor,
      filters: req.query,
    })
  );
}

async function purchaseAddonTopup(req, res) {
  res.status(201).json(
    await aiAddonService.purchaseTopup({
      workspaceId: req.workspace.id,
      userId: req.user?.id,
      packId: req.body?.packId,
    })
  );
}

async function applyAddonAdjustment(req, res) {
  res.json(
    await aiAddonService.applyAdjustment({
      workspaceId: req.workspace.id,
      userId: req.user?.id,
      type: req.body?.type,
      credits: req.body?.credits,
      reason: req.body?.reason,
    })
  );
}

async function dashboard(req, res) {
  res.json(
    await aiDashboardService.getDashboard({
      workspaceId: req.workspace.id,
      query: req.query,
    })
  );
}

async function billingSummary(req, res) {
  res.json(await aiBillingOperationsService.getBillingSummary({ workspaceId: req.workspace.id, query: req.query }));
}

async function billingStatements(req, res) {
  res.json(await aiBillingOperationsService.listBillingStatements({ workspaceId: req.workspace.id, query: req.query }));
}

async function billingStatement(req, res) {
  res.json(await aiBillingOperationsService.getBillingStatement({ workspaceId: req.workspace.id, periodKey: req.params.periodKey }));
}

async function downloadBillingStatement(req, res) {
  const file = await aiBillingOperationsService.downloadBillingStatementCsv({ workspaceId: req.workspace.id, periodKey: req.params.periodKey });
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
  res.send(file.body);
}

async function billingTimeline(req, res) {
  res.json(await aiBillingOperationsService.getBillingTimeline({ workspaceId: req.workspace.id, query: req.query }));
}

async function billingAnalytics(req, res) {
  res.json(await aiBillingOperationsService.getUsageAnalytics({ workspaceId: req.workspace.id, query: req.query }));
}

async function billingUsageExplorer(req, res) {
  res.json(await aiBillingOperationsService.getUsageExplorer({ workspaceId: req.workspace.id, query: req.query }));
}

async function billingBudget(req, res) {
  res.json(await aiBillingOperationsService.buildBudgetStatus(req.workspace.id));
}

async function updateBillingBudget(req, res) {
  res.json(
    await aiBillingOperationsService.upsertBudgetConfig({
      workspaceId: req.workspace.id,
      actorId: req.user?.id,
      payload: req.body || {},
    })
  );
}

async function billingReport(req, res) {
  if (String(req.query.format || "").toLowerCase() === "csv") {
    const file = await aiBillingOperationsService.downloadWorkspaceReportCsv({ workspaceId: req.workspace.id, query: req.query });
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    res.send(file.body);
    return;
  }
  res.json(await aiBillingOperationsService.getWorkspaceReport({ workspaceId: req.workspace.id, query: req.query }));
}

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
  addonStatus,
  purchaseAddon,
  listAddonTransactions,
  purchaseAddonTopup,
  applyAddonAdjustment,
  dashboard,
  billingSummary,
  billingStatements,
  billingStatement,
  downloadBillingStatement,
  billingTimeline,
  billingAnalytics,
  billingUsageExplorer,
  billingBudget,
  updateBillingBudget,
  billingReport,
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
