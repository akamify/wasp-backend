const mongoose = require("mongoose");
const { Contact } = require("@infra/database/Contact");
const { ContactList } = require("@infra/database/ContactList");

function listContactLists({ workspaceId, wabaId }) {
  return ContactList.find({ workspaceId, wabaId })
    .sort({ updatedAt: -1, name: 1 })
    .lean();
}

function getContactList({ id, workspaceId, wabaId }) {
  return ContactList.findOne({ _id: id, workspaceId, wabaId });
}

function getContactListLean({ id, workspaceId, wabaId }) {
  return ContactList.findOne({ _id: id, workspaceId, wabaId }).lean();
}

function createContactList(data) {
  return ContactList.create(data);
}

function deleteContactList({ id, workspaceId, wabaId }) {
  return ContactList.deleteOne({ _id: id, workspaceId, wabaId });
}

async function findExistingContactsByIds({ workspaceId, wabaId, contactIds }) {
  const ids = Array.from(
    new Set(
      (Array.isArray(contactIds) ? contactIds : [])
        .map((id) => String(id || "").trim())
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  ).map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];
  return Contact.find({ _id: { $in: ids }, workspaceId, wabaId })
    .select("_id name phone company tags")
    .sort({ updatedAt: -1, name: 1 })
    .lean();
}

module.exports = {
  listContactLists,
  getContactList,
  getContactListLean,
  createContactList,
  deleteContactList,
  findExistingContactsByIds,
};
