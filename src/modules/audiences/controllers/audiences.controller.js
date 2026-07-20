const audiencesService = require("@modules/audiences/services/audiences.service");

async function listAudiences(req, res) {
  res.json(await audiencesService.listAudiences(req));
}

async function getAudience(req, res) {
  res.json(await audiencesService.getAudience(req));
}

async function createAudience(req, res) {
  res.status(201).json(await audiencesService.createAudience(req));
}

async function updateAudience(req, res) {
  res.json(await audiencesService.updateAudience(req));
}

async function deleteAudience(req, res) {
  res.json(await audiencesService.deleteAudience(req));
}

async function previewAudienceContacts(req, res) {
  res.json(await audiencesService.previewAudienceContacts(req));
}

module.exports = {
  listAudiences,
  getAudience,
  createAudience,
  updateAudience,
  deleteAudience,
  previewAudienceContacts,
};
