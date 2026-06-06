const { HttpError } = require("@shared/utils/httpError");
const { contactAttributesRepository, contactsRepository } = require("@modules/contacts/repositories");
const {
  normalizeAttributeKey,
  normalizeAttributesMap,
  removeAttributeKeys,
  validateAttributeDefinitionPayload,
  toPlainAttributes,
} = require("@modules/contacts/utils/attributes.utils");
const { requireActiveWabaScope } = require("@shared/services/activeWabaScopeService");

async function getDefinitions(workspaceId, includeInactive = false) {
  return contactAttributesRepository.listDefinitions({ workspaceId, includeInactive });
}

async function listDefinitions(req) {
  const includeInactive = String(req.query.includeInactive || "") === "true";
  const includeUsage = String(req.query.includeUsage || "") === "true";
  const definitions = await getDefinitions(req.workspace.id, includeInactive);
  if (!includeUsage) return { success: true, definitions };
  const usage = await contactAttributesRepository.countUsageByKeys({
    workspaceId: req.workspace.id,
    keys: definitions.map((definition) => definition.key),
  });
  return { success: true, definitions: definitions.map((definition) => ({ ...definition, usageCount: usage[definition.key] || 0 })) };
}

async function getDefinition(req) {
  const key = normalizeAttributeKey(req.params.key);
  const definition = await contactAttributesRepository.findDefinition({ workspaceId: req.workspace.id, key });
  if (!definition) throw new HttpError(404, "Attribute definition not found");
  return { success: true, definition, usageCount: await contactAttributesRepository.countUsage({ workspaceId: req.workspace.id, key }) };
}

async function createDefinition(req) {
  const normalized = validateAttributeDefinitionPayload(req.body);
  try {
    const definition = await contactAttributesRepository.createDefinition({
      workspaceId: req.workspace.id,
      key: normalized.key,
      label: normalized.label,
      type: normalized.type,
      description: normalized.description,
      defaultValue: normalized.defaultValue,
      required: Boolean(req.body.required),
      visible: req.body.visible !== false,
      editable: req.body.editable !== false,
      active: true,
      createdBy: req.user?.id || null,
    });
    return { success: true, definition };
  } catch (error) {
    if (error?.code === 11000) throw new HttpError(409, `Attribute '${normalized.key}' already exists`);
    throw error;
  }
}

async function updateDefinition(req) {
  const key = normalizeAttributeKey(req.params.key);
  const definition = await contactAttributesRepository.findDefinition({ workspaceId: req.workspace.id, key });
  if (!definition) throw new HttpError(404, "Attribute definition not found");
  if (req.body.type !== undefined && req.body.type !== definition.type) {
    throw new HttpError(400, "Attribute type cannot be changed in v1");
  }
  validateAttributeDefinitionPayload({ ...req.body, type: definition.type }, { partial: true });
  for (const field of ["label", "description", "required", "visible", "editable", "active"]) {
    if (req.body[field] !== undefined) definition[field] = req.body[field];
  }
  if (req.body.defaultValue !== undefined) {
    const normalized = validateAttributeDefinitionPayload({ type: definition.type, defaultValue: req.body.defaultValue }, { partial: true });
    definition.defaultValue = normalized.defaultValue;
  }
  await contactAttributesRepository.saveDefinition(definition);
  return { success: true, definition };
}

async function archiveDefinition(req) {
  const key = normalizeAttributeKey(req.params.key);
  const definition = await contactAttributesRepository.findDefinition({ workspaceId: req.workspace.id, key });
  if (!definition) throw new HttpError(404, "Attribute definition not found");
  definition.active = false;
  await contactAttributesRepository.saveDefinition(definition);
  const usageCount = await contactAttributesRepository.countUsage({ workspaceId: req.workspace.id, key });
  return {
    success: true,
    definition,
    usageCount,
    message: "Attribute archived. Existing contact values remain stored.",
  };
}

async function updateContactAttributes(req, { replace = false } = {}) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const contact = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!contact) throw new HttpError(404, "Contact not found");
  const definitions = await getDefinitions(req.workspace.id, true);
  const normalized = normalizeAttributesMap(req.body.attributes, definitions);
  const legacy = Object.fromEntries(
    Object.entries(toPlainAttributes(contact.attributes)).filter(([key]) => !definitions.some((definition) => definition.key === key))
  );
  let next = replace ? normalized.values : { ...toPlainAttributes(contact.attributes), ...normalized.values };
  next = removeAttributeKeys(next, normalized.removals);
  if (replace && req.query.preserveLegacy === "true") next = { ...legacy, ...next };
  contact.attributes = next;
  await contact.save();
  return { success: true, contact };
}

async function deleteContactAttribute(req) {
  const scope = await requireActiveWabaScope(req.workspace.id);
  const contact = await contactsRepository.getContact({ id: req.params.id, workspaceId: req.workspace.id, wabaId: scope.wabaId });
  if (!contact) throw new HttpError(404, "Contact not found");
  const key = normalizeAttributeKey(req.params.key);
  const definition = await contactAttributesRepository.findDefinition({ workspaceId: req.workspace.id, key });
  if (definition?.required) throw new HttpError(400, `Attribute '${key}' is required`);
  contact.attributes = removeAttributeKeys(contact.attributes, [key]);
  await contact.save();
  return { success: true, contact };
}

module.exports = {
  getDefinitions,
  listDefinitions,
  getDefinition,
  createDefinition,
  updateDefinition,
  archiveDefinition,
  updateContactAttributes,
  deleteContactAttribute,
};
