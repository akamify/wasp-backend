const { HttpError } = require("@shared/utils/httpError");
const { contactsRepository } = require("@modules/contacts/repositories/index");
const { assertNormalizedPhone, normalizePhone } = require("@shared/services/contactService");
const { subscriptionRepository } = require("@modules/billing/repositories");
const { enforceMonthlyLimit } = require("@modules/billing/services/usageLimit.service");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");

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
  await enforceMonthlyLimit({
    workspaceId: req.workspace.id,
    limitKey: "maxContacts",
    errorMessage: "Monthly contact create limit reached for your current plan",
    countInWindow: (start, end) =>
      contactsRepository.countContactsCreatedBetween({ workspaceId: req.workspace.id, start, end }),
  });

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

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportContactsCsv(req) {
  if (isPlanRestrictionsEnabled()) {
  const activeSubscription = await subscriptionRepository.findActiveByWorkspace(req.workspace.id);
  const exportAllowed = activeSubscription
    ? Boolean(activeSubscription?.snapshot?.features?.exportAccess)
    : true;
  if (!exportAllowed) {
    throw new HttpError(403, "Your current plan does not allow contacts CSV export");
  }
  }

  await enforceMonthlyLimit({
    workspaceId: req.workspace.id,
    limitKeys: ["maxContactsExport", "maxExportsPerMonth"],
    errorMessage: "Monthly contacts export limit reached for your current plan",
    countInWindow: (start, end) =>
      contactsRepository.countContactExportsBetween({ workspaceId: req.workspace.id, start, end }),
  });

  const ids = Array.from(new Set((req.body?.contactIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  if (!ids.length) throw new HttpError(400, "Please select at least one contact to export");

  const rows = await contactsRepository.findContactsForExport({ workspaceId: req.workspace.id, ids });
  if (!rows.length) throw new HttpError(404, "No contacts found for selected IDs");

  const header = ["name", "phone", "company", "tags"];
  const csvRows = [header.join(",")];
  for (const row of rows) {
    const values = [
      escapeCsvCell(row.name || ""),
      escapeCsvCell(row.phone || ""),
      escapeCsvCell(row.company || ""),
      escapeCsvCell(Array.isArray(row.tags) ? row.tags.join("|") : ""),
    ];
    csvRows.push(values.join(","));
  }

  await contactsRepository.writeContactExportAudit({
    actorId: req.user?.id || null,
    workspaceId: req.workspace.id,
    exportedCount: rows.length,
  });

  return {
    success: true,
    filename: `contacts-export-${Date.now()}.csv`,
    csv: csvRows.join("\n"),
    exportedCount: rows.length,
  };
}

module.exports = {
  listContacts,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
  exportContactsCsv,
};


