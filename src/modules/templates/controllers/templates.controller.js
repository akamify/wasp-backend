const templatesService = require("@modules/templates/services/templates.service");

async function createTemplate(req, res) {
  const result = await templatesService.createTemplate(req);
  res.status(201).json(result);
}

async function createDraftTemplate(req, res) {
  const result = await templatesService.createDraftTemplate(req);
  res.status(201).json(result);
}

async function listTemplates(req, res) {
  res.json(await templatesService.listTemplates(req));
}

async function listApprovedTemplates(req, res) {
  res.json(await templatesService.listApprovedTemplates(req));
}

async function listLibraryTemplates(req, res) {
  res.json(await templatesService.listLibraryTemplates(req));
}

async function getLibraryAnalytics(req, res) {
  res.json(await templatesService.getLibraryAnalytics(req));
}

async function listLibraryTemplatePacks(req, res) {
  res.json(await templatesService.listLibraryTemplatePacks(req));
}

async function getTemplate(req, res) {
  res.json(await templatesService.getTemplate(req));
}

async function updateTemplate(req, res) {
  res.json(await templatesService.updateTemplate(req));
}

async function updateDraftTemplate(req, res) {
  res.json(await templatesService.updateDraftTemplate(req));
}

async function deleteTemplate(req, res) {
  res.json(await templatesService.deleteTemplate(req));
}

async function submitForApproval(req, res) {
  res.json(await templatesService.submitForApproval(req));
}

async function duplicateTemplate(req, res) {
  const result = await templatesService.duplicateTemplate(req);
  res.status(201).json(result);
}

async function favoriteLibraryTemplate(req, res) {
  res.json(await templatesService.favoriteLibraryTemplate(req));
}

async function unfavoriteLibraryTemplate(req, res) {
  res.json(await templatesService.unfavoriteLibraryTemplate(req));
}

async function trackLibraryTemplateEvent(req, res) {
  res.json(await templatesService.trackLibraryTemplateEvent(req));
}

async function installLibraryTemplatePack(req, res) {
  const result = await templatesService.installLibraryTemplatePack(req);
  res.status(201).json(result);
}

async function syncStatus(req, res) {
  res.json(await templatesService.syncStatus(req));
}

async function syncMetaTemplates(req, res) {
  res.json(await templatesService.syncMetaTemplates(req));
}

async function listTemplateHistory(req, res) {
  res.json(await templatesService.listTemplateHistory(req));
}

async function restoreTemplateVersion(req, res) {
  res.json(await templatesService.restoreTemplateVersion(req));
}

module.exports = {
  createTemplate,
  createDraftTemplate,
  getLibraryAnalytics,
  listApprovedTemplates,
  listLibraryTemplatePacks,
  listLibraryTemplates,
  listTemplates,
  getTemplate,
  listTemplateHistory,
  restoreTemplateVersion,
  updateTemplate,
  updateDraftTemplate,
  deleteTemplate,
  submitForApproval,
  duplicateTemplate,
  favoriteLibraryTemplate,
  installLibraryTemplatePack,
  trackLibraryTemplateEvent,
  unfavoriteLibraryTemplate,
  syncStatus,
  syncMetaTemplates,
};

