const { HttpError } = require("@shared/utils/httpError");
const { contactsRepository } = require("@modules/contacts/repositories/index");
const { assertNormalizedPhone, normalizePhone } = require("@shared/services/contactService");
const { subscriptionRepository } = require("@modules/billing/repositories");
const { enforceMonthlyLimit } = require("@modules/billing/services/usageLimit.service");
const { isPlanRestrictionsEnabled } = require("@modules/billing/utils/planRestrictionToggle");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");
const { contactAttributesRepository } = require("@modules/contacts/repositories/index");
const {
  normalizeAttributesMap,
  removeAttributeKeys,
} = require("@modules/contacts/utils/attributes.utils");

function parseListPaging(req) {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 25), 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildListFilter(req, scope) {
  const filter = { workspaceId: req.workspace.id, wabaId: scope.wabaId };
  if (req.query.search) {
    const q = String(req.query.search).trim();
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [{ phone: rx }, { name: rx }, { email: rx }, { company: rx }];
    }
  }
  let attributeFilters = [];
  if (req.query.attributeFilters) {
    try {
      attributeFilters = typeof req.query.attributeFilters === "string"
        ? JSON.parse(req.query.attributeFilters)
        : req.query.attributeFilters;
    } catch {
      throw new HttpError(400, "attributeFilters must be valid JSON");
    }
  } else if (req.query.attributeKey) {
    attributeFilters = [{
      key: req.query.attributeKey,
      operator: req.query.attributeOperator || "equals",
      value: req.query.attributeValue,
    }];
  }
  if (attributeFilters.length > 10) throw new HttpError(400, "A maximum of 10 attribute filters is allowed");
  if (attributeFilters.length) {
    const definitions = await contactAttributesRepository.listDefinitions({ workspaceId: req.workspace.id, includeInactive: false });
    const definitionMap = new Map(definitions.map((definition) => [definition.key, definition]));
    const clauses = attributeFilters.map((item) => {
      const key = String(item?.key || "").trim().toLowerCase();
      const definition = definitionMap.get(key);
      if (!definition) throw new HttpError(400, `Attribute '${key}' is not defined or active`);
      const field = `attributes.${key}`;
      const operator = String(item?.operator || "equals").toLowerCase();
      if (operator === "exists") return { [field]: { $exists: true } };
      if (operator === "not_exists") return { [field]: { $exists: false } };
      const normalized = normalizeAttributesMap({ [key]: item?.value }, [definition]).values[key];
      if (operator === "equals") return { [field]: normalized };
      if (operator === "not_equals") return { [field]: { $ne: normalized } };
      if (operator === "contains" && definition.type === "text") {
        return { [field]: { $regex: escapeRegex(normalized), $options: "i" } };
      }
      throw new HttpError(400, `Operator '${operator}' is not supported for attribute '${key}'`);
    });
    filter.$and = [...(filter.$and || []), ...clauses];
  }
  return filter;
}

async function listContacts(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const { page, limit, skip } = parseListPaging(req);
  const filter = await buildListFilter(req, scope);
  const { contacts, total } = await contactsRepository.listContacts({ filter, skip, limit });
  return { success: true, contacts, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

async function getContact(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const contact = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!contact) throw new HttpError(404, "Contact not found");
  return { success: true, contact };
}

async function listContactTags(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const tags = await contactsRepository.listContactTags({ workspaceId: req.workspace.id, wabaId: scope.wabaId });
  return { success: true, tags };
}

async function lookupContactByPhone(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const phone = normalizePhone(req.params.phone);
  if (!phone) throw new HttpError(400, "Invalid phone number");
  const contact = await contactsRepository.findByPhone({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone });
  return { success: true, contact: contact || null, phone };
}

async function createContact(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  await enforceMonthlyLimit({
    workspaceId: req.workspace.id,
    limitKey: "maxContacts",
    errorMessage: "Monthly contact create limit reached for your current plan",
    countInWindow: (start, end) =>
      contactsRepository.countContactsCreatedBetween({ workspaceId: req.workspace.id, start, end }),
  });

  const phone = assertNormalizedPhone(req.body.phone);
  const duplicate = await contactsRepository.findIdByPhone({ workspaceId: req.workspace.id, wabaId: scope.wabaId, phone });
  if (duplicate) throw new HttpError(409, "A contact with this phone already exists");
  const definitions = await contactAttributesRepository.listDefinitions({ workspaceId: req.workspace.id, includeInactive: true });
  const normalizedAttributes = normalizeAttributesMap(req.body.attributes, definitions);

  const contact = await contactsRepository.createContact({
    workspaceId: req.workspace.id,
    wabaId: scope.wabaId,
    phoneNumberId: scope.phoneNumberId || null,
    phone,
    name: req.body.name || undefined,
    email: req.body.email ? String(req.body.email).trim().toLowerCase() : undefined,
    company: req.body.company || undefined,
    language: req.body.language ? String(req.body.language).trim() : undefined,
    notes: req.body.notes || undefined,
    tags: Array.from(new Set((req.body.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))),
    attributes: normalizedAttributes.values,
    source: "manual",
  });

  return { success: true, contact };
}

async function updateContact(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const existing = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!existing) throw new HttpError(404, "Contact not found");

  const nextPhone = req.body.phone ? assertNormalizedPhone(req.body.phone) : existing.phone;
  if (nextPhone !== existing.phone) {
    const duplicate = await contactsRepository.findDuplicateByPhone({
      workspaceId: req.workspace.id,
      wabaId: scope.wabaId,
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
    attributes: undefined,
  };
  if (req.body.attributes !== undefined) {
    const definitions = await contactAttributesRepository.listDefinitions({ workspaceId: req.workspace.id, includeInactive: true });
    const normalized = normalizeAttributesMap(req.body.attributes, definitions);
    updates.attributes = removeAttributeKeys(normalized.values, normalized.removals);
    if (normalized.removals.length) {
      existing.attributes = removeAttributeKeys(existing.attributes, normalized.removals);
    }
  }

  const contact = await contactsRepository.updateContact(existing, updates);
  return { success: true, contact };
}

async function deleteContact(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  await contactsRepository.deleteContact({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  return { success: true };
}

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function exportContactsCsv(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
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

  const rows = await contactsRepository.findContactsForExport({ workspaceId: req.workspace.id, wabaId: scope.wabaId, ids });
  if (!rows.length) throw new HttpError(404, "No contacts found for selected IDs");

  const header = ["name", "phone", "company", "tags", "attributes"];
  const csvRows = [header.join(",")];
  for (const row of rows) {
    const values = [
      escapeCsvCell(row.name || ""),
      escapeCsvCell(row.phone || ""),
      escapeCsvCell(row.company || ""),
      escapeCsvCell(Array.isArray(row.tags) ? row.tags.join("|") : ""),
      escapeCsvCell(row.attributes && typeof row.attributes === "object" ? JSON.stringify(row.attributes) : ""),
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
  listContactTags,
  getContact,
  lookupContactByPhone,
  createContact,
  updateContact,
  deleteContact,
  exportContactsCsv,
};


