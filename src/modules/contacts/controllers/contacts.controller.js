const contactsService = require("@modules/contacts/services/contacts.service");

async function listContacts(req, res) {
  res.json(await contactsService.listContacts(req));
}

async function getContact(req, res) {
  res.json(await contactsService.getContact(req));
}

async function listContactTags(req, res) {
  res.json(await contactsService.listContactTags(req));
}

async function lookupContactByPhone(req, res) {
  res.json(await contactsService.lookupContactByPhone(req));
}

async function createContact(req, res) {
  const body = await contactsService.createContact(req);
  res.status(201).json(body);
}

async function updateContact(req, res) {
  res.json(await contactsService.updateContact(req));
}

async function deleteContact(req, res) {
  res.json(await contactsService.deleteContact(req));
}

async function exportContactsCsv(req, res) {
  const body = await contactsService.exportContactsCsv(req);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${body.filename}"`);
  res.status(200).send(body.csv);
}

module.exports = {
  listContacts,
  listContactTags,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
  exportContactsCsv,
};

