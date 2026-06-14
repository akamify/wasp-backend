const flowsService = require("@modules/flows/services/flows.service");

async function createFlow(req, res) {
  const body = await flowsService.createFlow({
    workspaceId: req.workspace.id,
    actorId: req.user?.id,
    payload: req.body,
  });
  res.status(201).json(body);
}

async function listFlows(req, res) {
  res.json(
    await flowsService.listFlows({
      workspaceId: req.workspace.id,
      query: req.query,
    })
  );
}

async function getFlow(req, res) {
  res.json(
    await flowsService.getFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
    })
  );
}

async function updateFlowMetadata(req, res) {
  res.json(
    await flowsService.updateFlowMetadata({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
      payload: req.body,
    })
  );
}

async function saveDraft(req, res) {
  res.json(
    await flowsService.saveDraft({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
      payload: req.body,
    })
  );
}

async function softDeleteFlow(req, res) {
  res.json(
    await flowsService.softDeleteFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
    })
  );
}

async function listFlowVersions(req, res) {
  res.json(
    await flowsService.listFlowVersions({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
    })
  );
}

async function validateDraft(req, res) {
  res.json(
    await flowsService.validateDraft({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
    })
  );
}

async function publishFlow(req, res) {
  res.status(201).json(
    await flowsService.publishFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
    })
  );
}

async function pauseFlow(req, res) {
  res.json(
    await flowsService.pauseFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
    })
  );
}

async function resumeFlow(req, res) {
  res.json(
    await flowsService.resumeFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
    })
  );
}

async function archiveFlow(req, res) {
  res.json(
    await flowsService.archiveFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      actorId: req.user?.id,
    })
  );
}

async function startFlow(req, res) {
  res.status(201).json(
    await flowsService.startFlow({
      workspaceId: req.workspace.id,
      flowId: req.params.flowId,
      payload: req.body,
    })
  );
}

module.exports = {
  createFlow,
  listFlows,
  getFlow,
  updateFlowMetadata,
  saveDraft,
  softDeleteFlow,
  listFlowVersions,
  validateDraft,
  publishFlow,
  pauseFlow,
  resumeFlow,
  archiveFlow,
  startFlow,
};
