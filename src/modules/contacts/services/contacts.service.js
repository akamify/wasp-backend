const { HttpError } = require("@shared/utils/httpError");
const { contactsRepository } = require("@modules/contacts/repositories/index");
const { assertNormalizedPhone, normalizePhone } = require("@shared/services/contactService");

function parseListPaging(req) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function buildListFilter(req) {
  const filter = { workspaceId: req.workspace.id };
  if (req.query.search) {
    const q = String(req.query.search).trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ phone: rx }, { name: rx }, { email: rx }, { company: rx }];
    }
  }
  return filter;
}

async function listContacts(req) {
  const { page, limit, skip } = parseListPaging(req);
  const filter = buildListFilter(req);
  const { contacts, total } = await contactsRepository.listContacts({ filter, skip, limit });
  return { success: true, contacts, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getContact(req) {
  const contact = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id });
  if (!contact) throw new HttpError(404, "Contact not found");
  return { success: true, contact };
}

async function lookupContactByPhone(req) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");
  const contact = await contactsRepository.findByPhone({ workspaceId: req.workspace.id, phone });
  return { success: true, contact: contact || null, phone };
}

async function createContact(req) {
  const phone = assertNormalizedPhone(req.body.phone);
  const duplicate = await contactsRepository.findIdByPhone({ workspaceId: req.workspace.id, phone });
  if (duplicate) throw new HttpError(409, "A contact with this phone already exists");

  const contact = await contactsRepository.createContact({
    workspaceId: req.workspace.id,
    phone,
    name: req.body.name || undefined,
    email: req.body.email ? String(req.body.email).trim().toLowerCase() : undefined,
    company: req.body.company || undefined,
    language: req.body.language ? String(req.body.language).trim() : undefined,
    notes: req.body.notes || undefined,
    tags: Array.from(new Set((req.body.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))),
    source: "manual",
  });

  return { success: true, contact };
}

async function updateContact(req) {
  const existing = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id });
  if (!existing) throw new HttpError(404, "Contact not found");

  const nextPhone = req.body.phone ? assertNormalizedPhone(req.body.phone) : existing.phone;
  if (nextPhone !== existing.phone) {
    const duplicate = await contactsRepository.findDuplicateByPhone({
      workspaceId: req.workspace.id,
      phone: nextPhone,
      excludeId: existing._id,
    });
    if (duplicate) throw new HttpError(409, "A contact with this phone already exists");
  }

  const updates = {
    phone: nextPhone,
    name: req.body.name,
    email: req.body.email,
    company: req.body.company,
    language: req.body.language,
    notes: req.body.notes,
    tags: req.body.tags,
  };

  const contact = await contactsRepository.updateContact(existing, updates);
  return { success: true, contact };
}

async function deleteContact(req) {
  await contactsRepository.deleteContact({ id: req.params.id, workspaceId: req.workspace.id });
  return { success: true };
}

module.exports = {
  listContacts,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
};


