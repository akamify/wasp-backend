const contactAttributesService = require("@modules/contacts/services/contactAttributes.service");

async function listDefinitions(req, res) { res.json(await contactAttributesService.listDefinitions(req)); }
async function getDefinition(req, res) { res.json(await contactAttributesService.getDefinition(req)); }
async function createDefinition(req, res) { res.status(201).json(await contactAttributesService.createDefinition(req)); }
async function updateDefinition(req, res) { res.json(await contactAttributesService.updateDefinition(req)); }
async function archiveDefinition(req, res) { res.json(await contactAttributesService.archiveDefinition(req)); }
async function patchContactAttributes(req, res) { res.json(await contactAttributesService.updateContactAttributes(req)); }
async function replaceContactAttributes(req, res) { res.json(await contactAttributesService.updateContactAttributes(req, { replace: true })); }
async function deleteContactAttribute(req, res) { res.json(await contactAttributesService.deleteContactAttribute(req)); }

module.exports = {
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  archiveDefinition,
  patchContactAttributes,
  replaceContactAttributes,
  deleteContactAttribute,
};
