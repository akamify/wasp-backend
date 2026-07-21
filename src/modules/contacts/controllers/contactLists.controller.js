const contactListsService = require("@modules/contacts/services/contactLists.service");

async function listContactLists(req, res) {
  res.json(await contactListsService.listContactLists(req));
}

async function getContactList(req, res) {
  res.json(await contactListsService.getContactList(req));
}

async function createContactList(req, res) {
  res.status(201).json(await contactListsService.createContactList(req));
}

async function updateContactList(req, res) {
  res.json(await contactListsService.updateContactList(req));
}

async function deleteContactList(req, res) {
  res.json(await contactListsService.deleteContactList(req));
}

module.exports = {
  listContactLists,
  getContactList,
  createContactList,
  updateContactList,
  deleteContactList,
};
