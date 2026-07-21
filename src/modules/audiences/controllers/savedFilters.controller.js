const savedFiltersService = require("@modules/audiences/services/savedFilters.service");

async function listSavedFilters(req, res) {
  res.json(await savedFiltersService.listSavedFilters(req));
}

async function createSavedFilter(req, res) {
  res.status(201).json(await savedFiltersService.createSavedFilter(req));
}

async function updateSavedFilter(req, res) {
  res.json(await savedFiltersService.updateSavedFilter(req));
}

async function deleteSavedFilter(req, res) {
  res.json(await savedFiltersService.deleteSavedFilter(req));
}

module.exports = {
  listSavedFilters,
  createSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
};
