const { Contact } = require("../models/Contact");
const {
  assertNormalizedPhone,
  normalizePhone,
  upsertContactForUser,
} = require("../services/contactService");
const { HttpError } = require("../utils/httpError");

function matchesSearch(contact, search) {
  const query = String(search || "").trim().toLowerCase();
  if (!query) return true;

  return [contact.phone, contact.name, contact.email, contact.company]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query));
}

async function listContacts(req, res) {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const contacts = await Contact.find({ workspaceId: req.workspace.id }).sort({
    updatedAt: -1,
    name: 1,
  });

  const filtered = req.query.search
    ? contacts.filter((contact) => matchesSearch(contact, req.query.search))
    : contacts;

  res.json({ success: true, contacts: filtered.slice(0, limit) });
}

async function getContact(req, res) {
  const contact = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!contact) throw new HttpError(404, "Contact not found");
  res.json({ success: true, contact });
}

async function lookupContactByPhone(req, res) {
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");

  const contact = await Contact.findOne({ workspaceId: req.workspace.id, phone });
  res.json({ success: true, contact: contact || null, phone });
}

async function createContact(req, res) {
  const phone = assertNormalizedPhone(req.body.phone);
  const contact = await upsertContactForUser({
    userId: req.workspace.id,
    phone,
    patch: {
      name: req.body.name,
      email: req.body.email,
      company: req.body.company,
      notes: req.body.notes,
      tags: req.body.tags,
      source: "manual",
    },
    createIfMissing: true,
  });

  res.status(201).json({ success: true, contact });
}

async function updateContact(req, res) {
  const existing = await Contact.findOne({ _id: req.params.id, workspaceId: req.workspace.id });
  if (!existing) throw new HttpError(404, "Contact not found");

  const nextPhone = req.body.phone ? assertNormalizedPhone(req.body.phone) : existing.phone;

  if (nextPhone !== existing.phone) {
    const duplicate = await Contact.findOne({
      workspaceId: req.workspace.id,
      phone: nextPhone,
      _id: { $ne: existing._id },
    });
    if (duplicate) {
      throw new HttpError(409, "A contact with this phone already exists");
    }
  }

  existing.phone = nextPhone;
  if (req.body.name !== undefined) existing.name = req.body.name || undefined;
  if (req.body.email !== undefined) {
    existing.email = req.body.email ? String(req.body.email).trim().toLowerCase() : undefined;
  }
  if (req.body.company !== undefined) existing.company = req.body.company || undefined;
  if (req.body.notes !== undefined) existing.notes = req.body.notes || undefined;
  if (req.body.tags !== undefined) {
    existing.tags = Array.from(
      new Set((req.body.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))
    );
  }

  const contact = await existing.save();
  res.json({ success: true, contact });
}

async function deleteContact(req, res) {
  await Contact.deleteOne({ _id: req.params.id, workspaceId: req.workspace.id });
  res.json({ success: true });
}

module.exports = {
  listContacts,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
};
