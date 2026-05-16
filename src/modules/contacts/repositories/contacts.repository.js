const { Contact } = require("@infra/database/Contact");

async function listContacts({ filter, skip, limit }) {
  const [contacts, total] = await Promise.all([
    Contact.find(filter).sort({ updatedAt: -1, name: 1 }).skip(skip).limit(limit),
    Contact.countDocuments(filter),
  ]);
  return { contacts, total };
}

async function getContact({ id, workspaceId }) {
  return Contact.findOne({ _id: id, workspaceId });
}

async function findByPhone({ workspaceId, phone }) {
  return Contact.findOne({ workspaceId, phone });
}

async function findIdByPhone({ workspaceId, phone }) {
  return Contact.findOne({ workspaceId, phone }).select("_id");
}

async function findDuplicateByPhone({ workspaceId, phone, excludeId }) {
  return Contact.findOne({ workspaceId, phone, _id: { $ne: excludeId } }).select("_id");
}

async function createContact(data) {
  return Contact.create(data);
}

async function updateContact(existingDoc, updates) {
  const nextTags =
    updates.tags !== undefined
      ? Array.from(new Set((updates.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean)))
      : undefined;

  existingDoc.phone = updates.phone;
  if (updates.name !== undefined) existingDoc.name = updates.name || undefined;
  if (updates.email !== undefined) existingDoc.email = updates.email ? String(updates.email).trim().toLowerCase() : undefined;
  if (updates.company !== undefined) existingDoc.company = updates.company || undefined;
  if (updates.language !== undefined) existingDoc.language = updates.language ? String(updates.language).trim() : undefined;
  if (updates.notes !== undefined) existingDoc.notes = updates.notes || undefined;
  if (updates.tags !== undefined) existingDoc.tags = nextTags;
  return existingDoc.save();
}

async function deleteContact({ id, workspaceId }) {
  return Contact.deleteOne({ _id: id, workspaceId });
}

module.exports = {
  listContacts,
  getContact,
  findByPhone,
  findIdByPhone,
  findDuplicateByPhone,
  createContact,
  updateContact,
  deleteContact,
};

