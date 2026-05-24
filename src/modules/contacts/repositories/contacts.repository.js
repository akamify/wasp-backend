const { Contact } = require("@infra/database/Contact");
const { AuditLog } = require("@infra/database/AuditLog");

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

async function findContactsForExport({ workspaceId, ids }) {
  return Contact.find({ _id: { $in: ids }, workspaceId })
    .select("name phone company tags")
    .sort({ updatedAt: -1, name: 1 })
    .lean();
}

async function countContactsCreatedBetween({ workspaceId, start, end }) {
  return Contact.countDocuments({
    workspaceId,
    createdAt: { $gte: start, $lt: end },
  });
}

async function countContactExportsBetween({ workspaceId, start, end }) {
  return AuditLog.countDocuments({
    action: "contacts.export.csv",
    "metadata.workspaceId": String(workspaceId),
    createdAt: { $gte: start, $lt: end },
  });
}

async function writeContactExportAudit({ actorId, workspaceId, exportedCount }) {
  return AuditLog.create({
    actorId: actorId || null,
    action: "contacts.export.csv",
    resourceType: "contacts",
    metadata: {
      workspaceId: String(workspaceId),
      exportedCount: Number(exportedCount || 0),
    },
  });
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
  findContactsForExport,
  countContactsCreatedBetween,
  countContactExportsBetween,
  writeContactExportAudit,
};

