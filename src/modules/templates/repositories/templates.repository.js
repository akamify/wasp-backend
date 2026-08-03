const { Template } = require("@infra/database/Template");

function visibleTemplateFilter({ workspaceId, wabaId }) {
  return {
    workspaceId,
    wabaId,
    isActive: { $ne: false },
    deletedAt: null,
  };
}

function systemLibraryOwnerFilter() {
  return {
    $or: [
      { ownerType: "system" },
      {
        ownerType: { $exists: false },
        workspaceId: null,
      },
    ],
  };
}

function publishedLibraryFilter(extra = {}) {
  return {
    ...systemLibraryOwnerFilter(),
    status: /^published$/i,
    isActive: { $ne: false },
    deletedAt: null,
    ...extra,
  };
}

async function createTemplate(data) {
  return Template.create(data);
}

async function incrementTemplatePopularity({ id, amount = 1 }) {
  return Template.findByIdAndUpdate(
    id,
    { $inc: { popularity: Number(amount || 1) } },
    { new: true }
  );
}

async function listTemplates({ workspaceId, wabaId, status }) {
  return Template.find({
    ...visibleTemplateFilter({ workspaceId, wabaId }),
    ...(status ? { status } : {}),
  }).sort({ createdAt: -1 });
}

async function listDraftTemplates({ workspaceId }) {
  return Template.find({
    workspaceId,
    status: "draft",
    deletedAt: null,
    isActive: { $ne: false },
  }).sort({ updatedAt: -1, createdAt: -1 });
}

async function listPublishedLibraryTemplates({ q, category, industry, language, tag, sort = "recent", limit = 100 }) {
  const search = String(q || "").trim();
  const rx = search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
  const query = {
    ...publishedLibraryFilter(),
    ...(category ? { category: String(category).trim().toLowerCase() } : {}),
    ...(industry ? { industry: String(industry).trim() } : {}),
    ...(tag ? { tags: String(tag).trim() } : {}),
  };
  const andConditions = [];
  if (language) {
    andConditions.push({
      $or: [
        { languageCode: String(language).trim() },
        { language: String(language).trim() },
      ],
    });
  }
  if (rx) {
    andConditions.push({
      $or: [
        { name: rx },
        { language: rx },
        { category: rx },
        { libraryCategory: rx },
        { industry: rx },
        { tags: rx },
      ],
    });
  }
  if (andConditions.length) query.$and = andConditions;
  const normalizedSort = String(sort || "recent").trim().toLowerCase();
  const sortMap = normalizedSort === "popular"
    ? { featured: -1, popularity: -1, updatedAt: -1 }
    : normalizedSort === "name"
      ? { name: 1, updatedAt: -1 }
      : normalizedSort === "newest"
        ? { featured: -1, createdAt: -1, updatedAt: -1 }
        : { featured: -1, updatedAt: -1 };
  return Template.find(query)
    .sort(sortMap)
    .limit(Math.min(Math.max(Number(limit || 100), 1), 200));
}

async function getPublishedLibraryTemplate({ id }) {
  return Template.findOne({
    _id: id,
    ...publishedLibraryFilter(),
  });
}

async function listPublishedLibraryTemplatesByPack({ packKey }) {
  return Template.find({
    ...publishedLibraryFilter(),
    templatePackKey: String(packKey || "").trim(),
  }).sort({ templatePackOrder: 1, updatedAt: -1, createdAt: -1 });
}

async function listPublishedLibraryPackTemplates() {
  return Template.find({
    ...publishedLibraryFilter(),
    templatePackKey: { $nin: [null, ""] },
  }).sort({ templatePackName: 1, templatePackOrder: 1, updatedAt: -1 });
}

async function getTemplate({ id, workspaceId, wabaId }) {
  return Template.findOne({ _id: id, ...visibleTemplateFilter({ workspaceId, wabaId }) });
}

async function getDraftTemplate({ id, workspaceId }) {
  return Template.findOne({
    _id: id,
    workspaceId,
    status: "draft",
    deletedAt: null,
    isActive: { $ne: false },
  });
}

async function getWorkspaceTemplate({ id, workspaceId }) {
  return Template.findOne({ _id: id, workspaceId });
}

async function findWorkspaceTemplateByNameLanguage({
  workspaceId,
  name,
  languageCode,
  wabaId = null,
  excludeId,
}) {
  return Template.findOne({
    workspaceId,
    name,
    languageCode,
    wabaId,
    deletedAt: null,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
}

async function countHiddenStaleTemplates({ workspaceId, wabaId }) {
  return Template.countDocuments({
    workspaceId,
    status: { $ne: "draft" },
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
    {
      workspaceId,
      status: { $ne: "draft" },
      wabaId: { $nin: [activeWabaId, null] },
    },
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

async function countStoredTemplates({ workspaceId }) {
  return Template.countDocuments({
    workspaceId,
    deletedAt: null,
    isActive: { $ne: false },
    ownerType: { $ne: "system" },
  });
}

module.exports = {
  countHiddenStaleTemplates,
  countTemplatesCreatedBetween,
  countStoredTemplates,
  createTemplate,
  incrementTemplatePopularity,
  findWorkspaceTemplateByNameLanguage,
  findTemplateForMetaSync,
  getDraftTemplate,
  getPublishedLibraryTemplate,
  listPublishedLibraryPackTemplates,
  listPublishedLibraryTemplatesByPack,
  getTemplate,
  getWorkspaceTemplate,
  listPublishedLibraryTemplates,
  listDraftTemplates,
  listTemplates,
  markCurrentWabaTemplatesStaleExcept,
  markWorkspaceOldWabaTemplatesStale,
  softDeleteTemplate,
  visibleTemplateFilter,
};
