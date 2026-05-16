const templatesService = require("@modules/templates/services/templates.service");

async function createTemplate(req, res) {
  const result = await templatesService.createTemplate(req);
  res.status(201).json(result);
}

async function listTemplates(req, res) {
  res.json(await templatesService.listTemplates(req));
}

async function getTemplate(req, res) {
  res.json(await templatesService.getTemplate(req));
}

async function updateTemplate(req, res) {
  res.json(await templatesService.updateTemplate(req));
}

async function deleteTemplate(req, res) {
  res.json(await templatesService.deleteTemplate(req));
}

async function submitForApproval(req, res) {
  res.json(await templatesService.submitForApproval(req));
}

async function syncStatus(req, res) {
  res.json(await templatesService.syncStatus(req));
}

async function syncMetaTemplates(req, res) {
  res.json(await templatesService.syncMetaTemplates(req));
}

module.exports = {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  syncStatus,
  syncMetaTemplates,
};

