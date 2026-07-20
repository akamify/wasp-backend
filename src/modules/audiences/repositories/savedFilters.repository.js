const { SavedFilter } = require("@infra/database/SavedFilter");

function listSavedFilters({ workspaceId, wabaId }) {
  return SavedFilter.find({ workspaceId, wabaId }).sort({ updatedAt: -1, createdAt: -1 });
}

function getSavedFilter({ id, workspaceId, wabaId }) {
  return SavedFilter.findOne({ _id: id, workspaceId, wabaId });
}

function createSavedFilter(payload) {
  return SavedFilter.create(payload);
}

function deleteSavedFilter({ id, workspaceId, wabaId }) {
  return SavedFilter.deleteOne({ _id: id, workspaceId, wabaId });
}

module.exports = {
  listSavedFilters,
  getSavedFilter,
  createSavedFilter,
  deleteSavedFilter,
};
