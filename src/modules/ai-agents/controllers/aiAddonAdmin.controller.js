const service = require("@modules/ai-agents/services/aiAddonAdmin.service");
const aiProviderConfigService = require("@modules/ai-agents/services/aiProviderConfig.service");

async function listPlans(req, res) {
  res.json(await service.listPlans());
}

async function createPlan(req, res) {
  res.json(await service.createPlan(req.body || {}));
}

async function updatePlan(req, res) {
  res.json(await service.updatePlan(req.params.planId, req.body || {}));
}

async function publishPlan(req, res) {
  res.json(await service.changePlanStatus(req.params.planId, "published"));
}

async function disablePlan(req, res) {
  res.json(await service.changePlanStatus(req.params.planId, "disabled"));
}

async function archivePlan(req, res) {
  res.json(await service.changePlanStatus(req.params.planId, "archived"));
}

async function deletePlan(req, res) {
  res.json(await service.deletePlan(req.params.planId));
}

async function listTopupPacks(req, res) {
  res.json(await service.listTopupPacks());
}

async function createTopupPack(req, res) {
  res.json(await service.createTopupPack(req.body || {}));
}

async function updateTopupPack(req, res) {
  res.json(await service.updateTopupPack(req.params.packId, req.body || {}));
}

async function publishTopupPack(req, res) {
  res.json(await service.changeTopupPackStatus(req.params.packId, "published"));
}

async function disableTopupPack(req, res) {
  res.json(await service.changeTopupPackStatus(req.params.packId, "disabled"));
}

async function archiveTopupPack(req, res) {
  res.json(await service.changeTopupPackStatus(req.params.packId, "archived"));
}

async function deleteTopupPack(req, res) {
  res.json(await service.deleteTopupPack(req.params.packId));
}

async function listSubscriptions(req, res) {
  res.json(await service.listSubscriptions({ query: req.query }));
}

async function assignWorkspacePlan(req, res) {
  res.json(
    await service.assignWorkspacePlan({
      workspaceId: req.params.workspaceId,
      planId: req.body?.planId,
      userId: req.user?.id,
      preserveTopups: req.body?.preserveTopups !== false,
    })
  );
}

async function workspaceLookup(req, res) {
  res.json(await service.workspaceLookup({ query: req.query.q }));
}

async function getProviderConfig(_req, res) {
  res.json({ success: true, item: await aiProviderConfigService.getGeminiProviderConfig() });
}

async function updateProviderConfig(req, res) {
  res.json({
    success: true,
    item: await aiProviderConfigService.updateGeminiProviderConfig({
      payload: req.body || {},
      actorId: req.user?.id || null,
    }),
  });
}

async function financialDashboard(req, res) {
  res.json(await service.getFinancialDashboard({ query: req.query }));
}

async function ledgerHistory(req, res) {
  res.json(await service.getLedgerHistory({ query: req.query }));
}

async function issueWorkspaceFinancialAction(req, res) {
  res.json(
    await service.issueWorkspaceFinancialAction({
      workspaceId: req.params.workspaceId,
      actorId: req.user?.id,
      actorName: req.user?.name || req.user?.email || "Super Admin",
      payload: req.body || {},
    })
  );
}

async function statements(req, res) {
  res.json(await service.listWorkspaceStatements({ query: req.query }));
}

async function adminReport(req, res) {
  if (String(req.query.format || "").toLowerCase() === "csv") {
    const file = await service.downloadAdminReport({ query: req.query });
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename=\"${file.filename}\"`);
    res.send(file.body);
    return;
  }
  res.json(await service.getAdminReport({ query: req.query }));
}

module.exports = {
  archivePlan,
  archiveTopupPack,
  assignWorkspacePlan,
  createPlan,
  createTopupPack,
  deletePlan,
  deleteTopupPack,
  disablePlan,
  disableTopupPack,
  listPlans,
  listSubscriptions,
  listTopupPacks,
  financialDashboard,
  ledgerHistory,
  issueWorkspaceFinancialAction,
  statements,
  adminReport,
  publishPlan,
  publishTopupPack,
  getProviderConfig,
  updatePlan,
  updateTopupPack,
  updateProviderConfig,
  workspaceLookup,
};
