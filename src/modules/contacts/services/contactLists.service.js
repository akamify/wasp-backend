const mongoose = require("mongoose");
const { HttpError } = require("@shared/utils/httpError");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { contactListsRepository } = require("@modules/contacts/repositories");

async function listContactLists(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const lists = await contactListsRepository.listContactLists({
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
  });
  return { success: true, lists };
}

async function getContactList(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const list = await contactListsRepository.getContactListLean({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
  });
  if (!list) throw new HttpError(404, "Contact list not found");
  return { success: true, list };
}

async function createContactList(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const name = String(req.body?.name || "").trim();
  if (!name) throw new HttpError(400, "List name is required");

  const contacts = await contactListsRepository.findExistingContactsByIds({
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
    contactIds: req.body?.contactIds,
  });
  if (!contacts.length) throw new HttpError(400, "Select at least one valid contact");

  try {
    const list = await contactListsRepository.createContactList({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
      name,
      description: String(req.body?.description || "").trim(),
      contactIds: contacts.map((contact) => contact._id),
      totalContacts: contacts.length,
      lastResolvedAt: new Date(),
      createdBy: req.user?.id || null,
      updatedBy: req.user?.id || null,
    });
    return {
      success: true,
      list: {
        ...list.toObject(),
        contactsPreview: contacts.slice(0, 5),
      },
    };
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw new HttpError(409, `A contact list named '${name}' already exists`);
    }
    throw error;
  }
}

async function updateContactList(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const list = await contactListsRepository.getContactList({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
  });
  if (!list) throw new HttpError(404, "Contact list not found");

  if (req.body?.name !== undefined) {
    const nextName = String(req.body.name || "").trim();
    if (!nextName) throw new HttpError(400, "List name is required");
    list.name = nextName;
  }
  if (req.body?.description !== undefined) {
    list.description = String(req.body.description || "").trim();
  }
  if (req.body?.contactIds !== undefined) {
    const contacts = await contactListsRepository.findExistingContactsByIds({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
      contactIds: req.body.contactIds,
    });
    if (!contacts.length) throw new HttpError(400, "Select at least one valid contact");
    list.contactIds = contacts.map((contact) => new mongoose.Types.ObjectId(String(contact._id)));
    list.totalContacts = contacts.length;
    list.lastResolvedAt = new Date();
  }
  list.updatedBy = req.user?.id || null;

  try {
    await list.save();
  } catch (error) {
    if (Number(error?.code) === 11000) {
      throw new HttpError(409, `A contact list named '${String(list.name || "").trim()}' already exists`);
    }
    throw error;
  }
  return { success: true, list };
}

async function deleteContactList(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const result = await contactListsRepository.deleteContactList({
    id: req.params.id,
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
  });
  if (!Number(result?.deletedCount || 0)) throw new HttpError(404, "Contact list not found");
  return { success: true };
}

module.exports = {
  listContactLists,
  getContactList,
  createContactList,
  updateContactList,
  deleteContactList,
};
