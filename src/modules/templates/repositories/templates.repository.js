const { Template } = require("@infra/database/Template");

function visibleTemplateFilter({ workspaceId, wabaId }) {
  return {
    workspaceId,
    wabaId,
    isActive: { $ne: false },
    deletedAt: null,
  };
}

async function createTemplate(data) {
  return Template.create(data);
}

async function listTemplates({ workspaceId, wabaId, status }) {
  return Template.find({
    ...visibleTemplateFilter({ workspaceId, wabaId }),
    ...(status ? { status } : {}),
  }).sort({ createdAt: -1 });
}

async function getTemplate({ id, workspaceId, wabaId }) {
  return Template.findOne({ _id: id, ...visibleTemplateFilter({ workspaceId, wabaId }) });
}

async function getWorkspaceTemplate({ id, workspaceId }) {
  return Template.findOne({ _id: id, workspaceId });
}

async function countHiddenStaleTemplates({ workspaceId, wabaId }) {
  return Template.countDocuments({
    workspaceId,
    $or: [
      { wabaId: { $ne: wabaId } },
      { isActive: false },
      { deletedAt: { $ne: null } },
    ],
  });
}

async function findTemplateForMetaSync({ workspaceId, wabaId, name, languageCode }) {
  return Template.findOne({ workspaceId, wabaId, name, languageCode });
}

async function markCurrentWabaTemplatesStaleExcept({ workspaceId, wabaId, activeKeys }) {
  const activeSet = new Set(activeKeys.map(({ name, languageCode }) => `${name}::${languageCode}`));
  const currentRows = await Template.find({ workspaceId, wabaId, deletedAt: null }).select("_id name languageCode");
  const staleIds = currentRows
    .filter((row) => !activeSet.has(`${String(row.name || "")}::${String(row.languageCode || row.language || "")}`))
    .map((row) => row._id);
  if (!staleIds.length) return { modifiedCount: 0 };
  return Template.updateMany(
    { _id: { $in: staleIds } },
    {
      $set: {
        isActive: false,
        staleReason: "missing_from_meta_refresh",
      },
    }
  );
}

async function markWorkspaceOldWabaTemplatesStale({ workspaceId, activeWabaId }) {
  return Template.updateMany(
    { workspaceId, wabaId: { $ne: activeWabaId } },
    { $set: { isActive: false, staleReason: "old_waba_connection" } }
  );
}

async function softDeleteTemplate({ id, workspaceId, staleReason = "deleted" }) {
  return Template.updateOne(
    { _id: id, workspaceId },
    { $set: { isActive: false, deletedAt: new Date(), staleReason } }
  );
}

async function countTemplatesCreatedBetween({ workspaceId, start, end }) {
  return Template.countDocuments({
    workspaceId,
    createdAt: { $gte: start, $lt: end },
  });
}

module.exports = {
  countHiddenStaleTemplates,
  countTemplatesCreatedBetween,
  createTemplate,
  findTemplateForMetaSync,
  getTemplate,
  getWorkspaceTemplate,
  listTemplates,
  markCurrentWabaTemplatesStaleExcept,
  markWorkspaceOldWabaTemplatesStale,
  softDeleteTemplate,
  visibleTemplateFilter,
};
