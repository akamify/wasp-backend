const { Contact } = require("@infra/database/Contact");
const { ContactAttributeDefinition } = require("@infra/database/ContactAttributeDefinition");

function listDefinitions({ workspaceId, includeInactive }) {
  const filter = { workspaceId };
  if (!includeInactive) filter.active = true;
  return ContactAttributeDefinition.find(filter).sort({ active: -1, label: 1, key: 1 }).lean();
}

function findDefinition({ workspaceId, key, activeOnly = false }) {
  const filter = { workspaceId, key };
  if (activeOnly) filter.active = true;
  return ContactAttributeDefinition.findOne(filter);
}

function createDefinition(data) {
  return ContactAttributeDefinition.create(data);
}

function saveDefinition(definition) {
  return definition.save();
}

function countUsage({ workspaceId, key }) {
  return Contact.countDocuments({ workspaceId, [`attributes.${key}`]: { $exists: true } });
}

async function countUsageByKeys({ workspaceId, keys }) {
  const entries = await Promise.all((keys || []).map(async (key) => [key, await countUsage({ workspaceId, key })]));
  return Object.fromEntries(entries);
}

module.exports = {
  listDefinitions,
  findDefinition,
  createDefinition,
  saveDefinition,
  countUsage,
  countUsageByKeys,
};
