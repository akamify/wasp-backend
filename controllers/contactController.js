const { Contact } = require("../models/Contact");
const {
  assertNormalizedPhone,
  normalizePhone,
} = require("../services/contactService");
const { HttpError } = require("../utils/httpError");

async function listContacts(req, res) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const skip = (page - 1) * limit;
  const filter = { workspaceId: req.workspace.id };

  if (req.query.search) {
    const q = String(req.query.search).trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ phone: rx }, { name: rx }, { email: rx }, { company: rx }];
    }
  }

  const [contacts, total] = await Promise.all([
    Contact.find(filter).sort({ updatedAt: -1, name: 1 }).skip(skip).limit(limit),
    Contact.countDocuments(filter),
  ]);

  res.json({ success: true, contacts, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
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
  const duplicate = await Contact.findOne({ workspaceId: req.workspace.id, phone }).select("_id");
  if (duplicate) throw new HttpError(409, "A contact with this phone already exists");

  const contact = await Contact.create({
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
  if (req.body.language !== undefined) existing.language = req.body.language ? String(req.body.language).trim() : undefined;
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
