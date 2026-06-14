const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const flowsRepository = require("@modules/flows/repositories/flows.repository");
const {
  validateFlowDraft,
  applyPublishDefaults,
} = require("@modules/flows/services/flowValidation.service");
const {
  testApiRequestNode,
} = require("@modules/flows/services/flowApiRequest.service");
const {
  testMediaNodeSource,
} = require("@modules/flows/services/flowMessageNodes.service");
const {
  manualStart,
} = require("@modules/flows/services/flowSession.service");
const {
  executeSession,
} = require("@modules/flows/services/flowRuntime.service");
const {
  normalizeRuntimeSettings,
} = require("@modules/flows/constants/flowRuntimeSettings");
const {
  computeFlowDraftHash,
} = require("@modules/flows/services/flowDraftHash.service");
const mediaAssetRepository = require("@modules/media/repositories/mediaAsset.repository");

function assertValidFlowId(flowId) {
  if (!mongoose.Types.ObjectId.isValid(String(flowId || ""))) {
    throw new HttpError(400, "Invalid flow id");
  }
}

function normalizeStringArray(values) {
  return Array.from(
    new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))
  );
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTrigger(trigger) {
  const value = trigger && typeof trigger === "object" ? trigger : {};
  return {
    type: value.type || null,
    keywords: normalizeStringArray(value.keywords),
    matchMode: value.matchMode || "exact",
    templateButtonPayloads: normalizeStringArray(value.templateButtonPayloads),
    ctwaPayloads: normalizeStringArray(value.ctwaPayloads),
  };
}

function parsePaging(query) {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 25), 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

async function addApprovedTemplateErrors({ workspaceId, flow, validation }) {
  const templateChecks = (flow?.draft?.nodes || [])
    .filter((node) => node?.type === "template")
    .map((node) => ({
      nodeId: node.id,
      templateName: String(node.config?.templateName || "").trim(),
      languageCode: String(node.config?.languageCode || "").trim(),
    }));
  const expiry = flow?.runtimeSettings?.onSessionExpired;
  if (expiry?.action === "template") {
    templateChecks.push({
      nodeId: null,
      templateName: String(expiry.templateName || "").trim(),
      languageCode: String(expiry.languageCode || "").trim(),
    });
  }

  for (const check of templateChecks) {
    if (!check.templateName || !check.languageCode) continue;
    const approved = await flowsRepository.findApprovedTemplate({
      workspaceId,
      name: check.templateName,
      languageCode: check.languageCode,
    });
    if (!approved) {
      validation.errors.push({
        code: "TEMPLATE_NOT_APPROVED",
        message: `Template '${check.templateName}' (${check.languageCode}) is not approved or active`,
        ...(check.nodeId ? { nodeId: check.nodeId } : {}),
        field: check.nodeId
          ? "config.templateName"
          : "runtimeSettings.onSessionExpired.templateName",
      });
    }
  }
  validation.valid = validation.errors.length === 0;
  return validation;
}

async function addMediaAssetErrors({ workspaceId, flow, validation }) {
  const mediaNodes = (flow?.draft?.nodes || []).filter((node) => {
    if (node?.type !== "media") return false;
    return ["upload", "library"].includes(
      String(node.config?.sourceType || "").trim()
    );
  });
  for (const node of mediaNodes) {
    const mediaAssetId = String(node.config?.mediaAssetId || "").trim();
    if (!mediaAssetId || !mongoose.Types.ObjectId.isValid(mediaAssetId)) {
      continue;
    }
    const asset = await mediaAssetRepository.findMediaAssetById({
      workspaceId,
      mediaAssetId,
    });
    if (!asset) {
      validation.errors.push({
        code: "MEDIA_ASSET_NOT_FOUND",
        message: "Selected media asset was not found or is not ready",
        nodeId: node.id,
        field: "config.mediaAssetId",
      });
      continue;
    }
    if (String(asset.mediaType) !== String(node.config?.mediaType || "")) {
      validation.errors.push({
        code: "MEDIA_TYPE_NOT_SUPPORTED",
        message: "Selected media asset type does not match the Media node type",
        nodeId: node.id,
        field: "config.mediaAssetId",
      });
    }
  }
  validation.valid = validation.errors.length === 0;
  return validation;
}

async function requireMutableFlow({ workspaceId, flowId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!flow) throw new HttpError(404, "Flow not found");
  if (flow.status === "archived") {
    throw new HttpError(409, "Archived flow cannot be updated");
  }
  return flow;
}

function normalizedConflictValues(values, { caseInsensitive = false } = {}) {
  return new Set(
    (values || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => (caseInsensitive ? value.toLowerCase() : value))
  );
}

async function assertNoTriggerConflict({ workspaceId, flowId, trigger }) {
  if (!trigger || trigger.type === "manual") return;

  const activeFlows = await flowsRepository.findActiveFlowsForTriggerConflict({
    workspaceId,
    excludeFlowId: flowId,
  });

  let field;
  let values;
  let caseInsensitive = false;
  if (trigger.type === "keyword" && trigger.matchMode === "exact") {
    field = "keywords";
    values = trigger.keywords;
    caseInsensitive = true;
  } else if (trigger.type === "template_button") {
    field = "templateButtonPayloads";
    values = trigger.templateButtonPayloads;
  } else if (trigger.type === "ctwa") {
    field = "ctwaPayloads";
    values = trigger.ctwaPayloads;
  } else {
    return;
  }

  const requested = normalizedConflictValues(values, { caseInsensitive });
  for (const activeFlow of activeFlows) {
    const activeTrigger = activeFlow.activeVersionId?.trigger;
    if (!activeTrigger || activeTrigger.type !== trigger.type) continue;
    if (
      trigger.type === "keyword" &&
      activeTrigger.matchMode !== "exact"
    ) {
      continue;
    }

    const existing = normalizedConflictValues(activeTrigger[field], {
      caseInsensitive,
    });
    const conflictValue = [...requested].find((value) => existing.has(value));
    if (conflictValue) {
      throw new HttpError(
        409,
        `Trigger conflict with active flow '${activeFlow.name}'`,
        {
          code: "FLOW_TRIGGER_CONFLICT",
          flowId: String(activeFlow._id),
          flowName: activeFlow.name,
          triggerType: trigger.type,
          value: conflictValue,
        }
      );
    }
  }
}

async function createFlow({ workspaceId, actorId, payload }) {
  let flow = await flowsRepository.createFlow({
    workspaceId,
    name: payload.name,
    description: payload.description || "",
    status: "draft",
    trigger: normalizeTrigger(null),
    runtimeSettings: normalizeRuntimeSettings(null),
    draft: {
      nodes: [],
      edges: [],
      fallbackNodeId: null,
      handoverNodeId: null,
    },
    createdBy: actorId || null,
    updatedBy: actorId || null,
  });
  flow = await flowsRepository.updateFlowById({
    workspaceId,
    flowId: flow._id,
    updates: {
      draftHash: computeFlowDraftHash(flow),
      lastValidationStatus: "stale",
      lastValidatedDraftHash: null,
    },
  });
  return { success: true, flow };
}

async function listFlows({ workspaceId, query }) {
  const { page, limit, skip } = parsePaging(query);
  const search = escapeRegex(String(query.search || "").trim());
  const { flows, total } = await flowsRepository.findFlows({
    workspaceId,
    status: query.status || null,
    search: search || null,
    skip,
    limit,
  });

  return {
    success: true,
    flows,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getFlow({ workspaceId, flowId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!flow) throw new HttpError(404, "Flow not found");
  return { success: true, flow };
}

async function updateFlowMetadata({ workspaceId, flowId, actorId, payload }) {
  const existing = await requireMutableFlow({ workspaceId, flowId });
  const nextState = {
    ...existing.toObject(),
    ...payload,
  };
  const flow = await flowsRepository.updateFlowById({
    workspaceId,
    flowId,
    updates: {
      ...payload,
      draftHash: computeFlowDraftHash(nextState),
      lastValidationStatus: "stale",
      lastValidatedDraftHash: null,
      lastValidatedAt: null,
      lastValidationErrors: [],
      lastValidationWarnings: [],
      updatedBy: actorId || null,
    },
  });
  if (!flow) throw new HttpError(409, "Flow is no longer available for update");
  return { success: true, flow };
}

async function saveDraft({ workspaceId, flowId, actorId, payload }) {
  const existing = await requireMutableFlow({ workspaceId, flowId });
  const trigger = normalizeTrigger(payload.trigger);
  const draft = {
    nodes: payload.nodes,
    edges: payload.edges,
    fallbackNodeId: payload.fallbackNodeId || null,
    handoverNodeId: payload.handoverNodeId || null,
  };
  const runtimeSettings = normalizeRuntimeSettings(
    payload.runtimeSettings || existing.runtimeSettings
  );
  const draftHash = computeFlowDraftHash({
    ...existing.toObject(),
    trigger,
    draft,
    runtimeSettings,
  });
  const flow = await flowsRepository.updateFlowById({
    workspaceId,
    flowId,
    updates: {
      trigger,
      draft,
      runtimeSettings,
      draftHash,
      lastValidationStatus: "stale",
      lastValidatedDraftHash: null,
      lastValidatedAt: null,
      lastValidationErrors: [],
      lastValidationWarnings: [],
      updatedBy: actorId || null,
    },
  });
  if (!flow) throw new HttpError(409, "Flow is no longer available for update");
  return { success: true, flow };
}

async function softDeleteFlow({ workspaceId, flowId, actorId }) {
  assertValidFlowId(flowId);
  const deletedAt = new Date();
  const flow = await flowsRepository.softDeleteFlow({
    workspaceId,
    flowId,
    actorId,
    deletedAt,
  });
  if (!flow) throw new HttpError(404, "Flow not found");
  return { success: true };
}

async function listFlowVersions({ workspaceId, flowId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({
    workspaceId,
    flowId,
    includeDeleted: true,
  });
  if (!flow) throw new HttpError(404, "Flow not found");
  const versions = await flowsRepository.listFlowVersions({ workspaceId, flowId });
  return { success: true, versions };
}

async function validateDraft({ workspaceId, flowId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!flow) throw new HttpError(404, "Flow not found");
  const draftHash = computeFlowDraftHash(flow);
  let validation = await addApprovedTemplateErrors({
    workspaceId,
    flow,
    validation: validateFlowDraft(flow),
  });
  validation = await addMediaAssetErrors({ workspaceId, flow, validation });
  await flowsRepository.updateFlowById({
    workspaceId,
    flowId,
    updates: {
      draftHash,
      lastValidationStatus: validation.valid ? "passed" : "failed",
      lastValidatedDraftHash: validation.valid ? draftHash : null,
      lastValidatedAt: new Date(),
      lastValidationErrors: validation.errors,
      lastValidationWarnings: validation.warnings,
    },
  });
  return { ...validation, draftHash };
}

async function publishFlow({ workspaceId, flowId, actorId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!flow) throw new HttpError(404, "Flow not found");
  if (flow.status === "archived") {
    throw new HttpError(409, "Archived flow cannot be published");
  }

  const draftHash = computeFlowDraftHash(flow);
  if (
    flow.lastValidationStatus !== "passed" ||
    !flow.lastValidatedDraftHash ||
    flow.lastValidatedDraftHash !== draftHash ||
    flow.draftHash !== draftHash
  ) {
    throw new HttpError(
      400,
      "Please save and validate the latest draft before publishing.",
      { code: "FLOW_VALIDATION_REQUIRED" }
    );
  }

  let validation = await addApprovedTemplateErrors({
    workspaceId,
    flow,
    validation: validateFlowDraft(flow),
  });
  validation = await addMediaAssetErrors({ workspaceId, flow, validation });
  if (!validation.valid) {
    await flowsRepository.updateFlowById({
      workspaceId,
      flowId,
      updates: {
        draftHash,
        lastValidationStatus: "failed",
        lastValidatedDraftHash: null,
        lastValidatedAt: new Date(),
        lastValidationErrors: validation.errors,
        lastValidationWarnings: validation.warnings,
      },
    });
    throw new HttpError(400, "Flow draft validation failed", validation);
  }

  await assertNoTriggerConflict({
    workspaceId,
    flowId,
    trigger: flow.trigger,
  });

  const latestVersion = await flowsRepository.findLatestFlowVersion({
    workspaceId,
    flowId,
  });
  const snapshot = applyPublishDefaults(flow.draft);
  let version;

  try {
    version = await flowsRepository.createFlowVersion({
      workspaceId,
      flowId,
      versionNumber: Number(latestVersion?.versionNumber || 0) + 1,
      status: "active",
      trigger: flow.trigger.toObject ? flow.trigger.toObject() : flow.trigger,
      runtimeSettings: normalizeRuntimeSettings(flow.runtimeSettings),
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      fallbackNodeId: snapshot.fallbackNodeId,
      handoverNodeId: snapshot.handoverNodeId,
      publishedBy: actorId || null,
      publishedAt: new Date(),
    });

    await flowsRepository.deactivateFlowVersions({
      workspaceId,
      flowId,
      excludeVersionId: version._id,
    });

    const updatedFlow = await flowsRepository.updateFlowStatus({
      workspaceId,
      flowId,
      expectedStatuses: ["draft", "active", "paused"],
      expectedDraftHash: draftHash,
      updates: {
        status: "active",
        activeVersionId: version._id,
        archivedAt: null,
        updatedBy: actorId || null,
      },
    });
    if (!updatedFlow) {
      throw new HttpError(409, "Flow is no longer available for publishing");
    }
  } catch (error) {
    if (version?._id) {
      await flowsRepository.deleteFlowVersion({
        workspaceId,
        flowId,
        versionId: version._id,
      });
      if (latestVersion?._id && latestVersion.status === "active") {
        await flowsRepository.activateFlowVersion({
          workspaceId,
          flowId,
          versionId: latestVersion._id,
        });
      }
    }
    if (error?.code === 11000) {
      throw new HttpError(409, "Flow was published concurrently. Please retry.");
    }
    throw error;
  }

  return { success: true, version, validation };
}

async function pauseFlow({ workspaceId, flowId, actorId }) {
  assertValidFlowId(flowId);
  const existing = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!existing) throw new HttpError(404, "Flow not found");
  if (existing.status !== "active") {
    throw new HttpError(409, "Only an active flow can be paused");
  }
  const flow = await flowsRepository.updateFlowStatus({
    workspaceId,
    flowId,
    expectedStatuses: ["active"],
    updates: { status: "paused", updatedBy: actorId || null },
  });
  if (!flow) throw new HttpError(409, "Flow is no longer available to pause");
  return { success: true, flow };
}

async function resumeFlow({ workspaceId, flowId, actorId }) {
  assertValidFlowId(flowId);
  const flow = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!flow) throw new HttpError(404, "Flow not found");
  if (flow.status !== "paused") {
    throw new HttpError(409, "Only a paused flow can be resumed");
  }
  if (!flow.activeVersionId) {
    throw new HttpError(409, "Flow has no published version to resume");
  }

  const activeVersion = await flowsRepository.findFlowVersionById({
    workspaceId,
    flowId,
    versionId: flow.activeVersionId,
  });
  if (!activeVersion) {
    throw new HttpError(409, "Active flow version could not be resolved");
  }

  await assertNoTriggerConflict({
    workspaceId,
    flowId,
    trigger: activeVersion.trigger,
  });

  const resumed = await flowsRepository.updateFlowStatus({
    workspaceId,
    flowId,
    expectedStatuses: ["paused"],
    updates: { status: "active", updatedBy: actorId || null },
  });
  if (!resumed) throw new HttpError(409, "Flow is no longer available to resume");
  return { success: true, flow: resumed };
}

async function archiveFlow({ workspaceId, flowId, actorId }) {
  assertValidFlowId(flowId);
  const existing = await flowsRepository.findFlowById({ workspaceId, flowId });
  if (!existing) throw new HttpError(404, "Flow not found");
  if (existing.status === "archived") {
    throw new HttpError(409, "Flow is already archived");
  }
  const flow = await flowsRepository.updateFlowStatus({
    workspaceId,
    flowId,
    expectedStatuses: ["draft", "active", "paused"],
    updates: {
      status: "archived",
      archivedAt: new Date(),
      updatedBy: actorId || null,
    },
  });
  if (!flow) throw new HttpError(409, "Flow is no longer available to archive");
  return { success: true, flow };
}

async function startFlow({ workspaceId, flowId, payload }) {
  const session = await manualStart({
    workspaceId,
    flowId,
    contactId: payload.contactId,
    initialContext: payload.initialContext || {},
    force: Boolean(payload.force),
  });
  const runtime = await executeSession({
    workspaceId,
    sessionId: session._id,
  });
  return { success: true, session: runtime.session || session, runtimeStatus: runtime.status };
}

async function testApiRequest({ workspaceId, payload }) {
  return testApiRequestNode({
    workspaceId,
    flowId: payload.flowId || null,
    nodeId: payload.nodeId || null,
    config: payload.config,
    sampleContext: payload.sampleContext || {},
    sampleContact: payload.sampleContact || {},
    sampleAttributes: payload.sampleAttributes || {},
  });
}

async function testMediaNode({ workspaceId, payload }) {
  return testMediaNodeSource({
    workspaceId,
    flowId: payload.flowId || null,
    nodeId: payload.nodeId || null,
    config: payload.config,
    sampleContext: payload.sampleContext || {},
    sampleContact: payload.sampleContact || {},
    sampleAttributes: payload.sampleAttributes || {},
  });
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
  testApiRequest,
  testMediaNode,
};
