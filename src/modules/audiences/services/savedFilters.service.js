const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { savedFiltersRepository } = require("@modules/audiences/repositories");
const { buildFilterCatalog, normalizeNode } = require("@modules/audiences/services/filterEngine.service");

async function listSavedFilters(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const savedFilters = await savedFiltersRepository.listSavedFilters({ workspaceId: req.workspace.id, wabaId: scope.wabaId });
  return {
    success: true,
    savedFilters,
    fieldCatalog: await buildFilterCatalog({ workspaceId: req.workspace.id }),
  };
}

async function createSavedFilter(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  try {
    const savedFilter = await savedFiltersRepository.createSavedFilter({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
      name: String(req.body?.name || "").trim(),
      description: String(req.body?.description || "").trim(),
      filterTree: normalizeNode(req.body?.filterTree),
      createdBy: req.user?.id || null,
      updatedBy: req.user?.id || null,
    });
    return { success: true, savedFilter };
  } catch (error) {
    if (Number(error?.code) === 11000) throw new HttpError(409, "A saved filter with this name already exists");
    throw error;
  }
}

async function updateSavedFilter(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const savedFilter = await savedFiltersRepository.getSavedFilter({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!savedFilter) throw new HttpError(404, "Saved filter not found");
  if (req.body?.name !== undefined) savedFilter.name = String(req.body.name || "").trim();
  if (req.body?.description !== undefined) savedFilter.description = String(req.body.description || "").trim();
  if (req.body?.filterTree !== undefined) savedFilter.filterTree = normalizeNode(req.body.filterTree);
  savedFilter.updatedBy = req.user?.id || null;
  try {
    await savedFilter.save();
  } catch (error) {
    if (Number(error?.code) === 11000) throw new HttpError(409, "A saved filter with this name already exists");
    throw error;
  }
  return { success: true, savedFilter };
}

async function deleteSavedFilter(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const result = await savedFiltersRepository.deleteSavedFilter({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!Number(result?.deletedCount || 0)) throw new HttpError(404, "Saved filter not found");
  return { success: true };
}

module.exports = {
  listSavedFilters,
  createSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
};
