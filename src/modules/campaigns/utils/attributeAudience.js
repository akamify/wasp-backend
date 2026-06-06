const { HttpError } = require("@shared/utils/httpError");
const { contactAttributesRepository } = require("@modules/contacts/repositories");
const { normalizeAttributesMap } = require("@modules/contacts/utils/attributes.utils");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildAttributeAudienceClauses({ workspaceId, filters }) {
  if (!Array.isArray(filters) || !filters.length) return [];
  if (filters.length > 10) throw new HttpError(400, "A maximum of 10 attribute filters is allowed");
  const definitions = await contactAttributesRepository.listDefinitions({ workspaceId, includeInactive: false });
  const definitionMap = new Map(definitions.map((definition) => [definition.key, definition]));
  return filters.map((item) => {
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
}

module.exports = { buildAttributeAudienceClauses };
