const { Flow } = require("@infra/database/Flow");
const { FlowVersion } = require("@infra/database/FlowVersion");
const { Template } = require("@infra/database/Template");

async function createFlow(data) {
  return Flow.create(data);
}

async function findFlows({ workspaceId, status, search, skip, limit }) {
  const filter = { workspaceId, deletedAt: null };
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { description: { $regex: search, $options: "i" } },
    ];
  }

  const [flows, total] = await Promise.all([
    Flow.find(filter)
      .select("-draft.nodes -draft.edges")
      .sort({ updatedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Flow.countDocuments(filter),
  ]);

  return { flows, total };
}

async function findFlowById({ workspaceId, flowId, includeDeleted = false }) {
  const filter = { _id: flowId, workspaceId };
  if (!includeDeleted) filter.deletedAt = null;
  return Flow.findOne(filter);
}

async function updateFlowById({ workspaceId, flowId, updates }) {
  return Flow.findOneAndUpdate(
    { _id: flowId, workspaceId, deletedAt: null, status: { $ne: "archived" } },
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  );
}

async function softDeleteFlow({ workspaceId, flowId, actorId, deletedAt }) {
  return Flow.findOneAndUpdate(
    { _id: flowId, workspaceId, deletedAt: null },
    {
      $set: {
        status: "archived",
        archivedAt: deletedAt,
        deletedAt,
        updatedBy: actorId || null,
      },
    },
    { returnDocument: "after", runValidators: true }
  );
}

async function createFlowVersion(data) {
  return FlowVersion.create(data);
}

async function findActiveFlowsForTriggerConflict({
  workspaceId,
  excludeFlowId,
}) {
  return Flow.find({
    workspaceId,
    _id: { $ne: excludeFlowId },
    status: "active",
    deletedAt: null,
    activeVersionId: { $ne: null },
  })
    .select("_id name activeVersionId")
    .populate({ path: "activeVersionId", select: "trigger" })
    .lean();
}

async function findLatestFlowVersion({ workspaceId, flowId }) {
  return FlowVersion.findOne({ workspaceId, flowId }).sort({ versionNumber: -1 });
}

async function findFlowVersionById({ workspaceId, flowId, versionId }) {
  return FlowVersion.findOne({ _id: versionId, workspaceId, flowId });
}

async function deactivateFlowVersions({ workspaceId, flowId, excludeVersionId }) {
  const filter = { workspaceId, flowId, status: "active" };
  if (excludeVersionId) filter._id = { $ne: excludeVersionId };
  return FlowVersion.updateMany(filter, { $set: { status: "inactive" } });
}

async function activateFlowVersion({ workspaceId, flowId, versionId }) {
  return FlowVersion.findOneAndUpdate(
    { _id: versionId, workspaceId, flowId },
    { $set: { status: "active" } },
    { returnDocument: "after", runValidators: true }
  );
}

async function deleteFlowVersion({ workspaceId, flowId, versionId }) {
  return FlowVersion.deleteOne({ _id: versionId, workspaceId, flowId });
}

async function updateFlowStatus({
  workspaceId,
  flowId,
  expectedStatuses,
  expectedDraftHash,
  updates,
}) {
  const filter = {
    _id: flowId,
    workspaceId,
    deletedAt: null,
    status: { $in: expectedStatuses },
  };
  if (expectedDraftHash) filter.draftHash = expectedDraftHash;
  return Flow.findOneAndUpdate(
    filter,
    { $set: updates },
    { returnDocument: "after", runValidators: true }
  );
}

async function listFlowVersions({ workspaceId, flowId }) {
  return FlowVersion.find({ workspaceId, flowId }).sort({
    versionNumber: -1,
    createdAt: -1,
  });
}

async function findApprovedTemplate({ workspaceId, name, languageCode }) {
  return Template.findOne({
    workspaceId,
    name,
    languageCode,
    status: "approved",
    isActive: { $ne: false },
    deletedAt: null,
  })
    .select("_id")
    .lean();
}

module.exports = {
  createFlow,
  findFlows,
  findFlowById,
  updateFlowById,
  softDeleteFlow,
  createFlowVersion,
  findActiveFlowsForTriggerConflict,
  findLatestFlowVersion,
  findFlowVersionById,
  deactivateFlowVersions,
  activateFlowVersion,
  deleteFlowVersion,
  updateFlowStatus,
  listFlowVersions,
  findApprovedTemplate,
};
