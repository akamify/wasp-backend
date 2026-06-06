const { HttpError } = require("@shared/utils/httpError");

const ATTRIBUTE_TYPES = ["text", "number", "boolean", "date", "url"];
const ATTRIBUTE_KEY_REGEX = /^[a-z][a-z0-9_]{0,49}$/;
const RESERVED_ATTRIBUTE_KEYS = new Set([
  "id", "_id", "phone", "name", "email", "company", "tags", "workspaceid",
  "wabaid", "attributes", "createdat", "updatedat",
]);

function normalizeAttributeKey(key) {
  return String(key || "").trim().toLowerCase();
}

function isValidAttributeKey(key) {
  const normalized = normalizeAttributeKey(key);
  return ATTRIBUTE_KEY_REGEX.test(normalized) && !RESERVED_ATTRIBUTE_KEYS.has(normalized);
}

function normalizeAttributeValue(value, type) {
  if (value === null || value === undefined || value === "") return undefined;
  if (type === "text") return String(value).trim();
  if (type === "number") {
    const normalized = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(normalized) ? normalized : value;
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "no") return false;
    return value;
  }
  if (type === "date") {
    const parsed = new Date(String(value).trim());
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (type === "url") return String(value).trim();
  return value;
}

function validateAttributeValue(value, type) {
  if (value === undefined) return true;
  if (Array.isArray(value) || (value && typeof value === "object")) return false;
  if (type === "text") return typeof value === "string" && value.length <= 200;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "date") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "url") {
    if (typeof value !== "string" || value.length > 200) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  return false;
}

function validateAttributeDefinitionPayload(payload, { partial = false } = {}) {
  const errors = [];
  const key = normalizeAttributeKey(payload?.key);
  const type = String(payload?.type || "text").toLowerCase();
  if (!partial && !isValidAttributeKey(key)) {
    errors.push("Key must start with a letter and use lowercase snake_case only (max 50 characters)");
  }
  if (!partial && (!String(payload?.label || "").trim() || String(payload.label).trim().length > 80)) {
    errors.push("Label is required and must be 80 characters or fewer");
  }
  if (payload?.description !== undefined && String(payload.description).length > 300) {
    errors.push("Description must be 300 characters or fewer");
  }
  if (payload?.type !== undefined && !ATTRIBUTE_TYPES.includes(type)) errors.push("Invalid attribute type");
  if (payload?.defaultValue !== undefined && payload.defaultValue !== "") {
    const normalized = normalizeAttributeValue(payload.defaultValue, type);
    if (!validateAttributeValue(normalized, type)) errors.push("Default value does not match attribute type");
  }
  if (errors.length) throw new HttpError(400, errors[0], { errors });
  return {
    key,
    type,
    label: payload?.label !== undefined ? String(payload.label).trim() : undefined,
    description: payload?.description !== undefined ? String(payload.description).trim() : undefined,
    defaultValue: payload?.defaultValue === "" ? undefined : normalizeAttributeValue(payload?.defaultValue, type),
  };
}

function toPlainAttributes(input) {
  if (input instanceof Map) return Object.fromEntries(input.entries());
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return { ...input };
}

function normalizeAttributesMap(input, definitions, options = {}) {
  const { allowUnknown = false, enforceRequired = false } = options;
  const definitionMap = new Map((definitions || []).map((definition) => [definition.key, definition]));
  const values = {};
  const removals = [];
  const warnings = [];
  for (const [rawKey, rawValue] of Object.entries(toPlainAttributes(input))) {
    const rawTrimmedKey = String(rawKey || "").trim();
    const key = normalizeAttributeKey(rawKey);
    if (!key || (!allowUnknown && key !== rawTrimmedKey)) {
      throw new HttpError(400, `Invalid attribute key '${rawKey}'`);
    }
    const definition = definitionMap.get(key);
    if (!definition || !definition.active) {
      if (!allowUnknown) throw new HttpError(400, `Attribute '${key}' is not defined or active`);
      const legacyValue = rawValue === null || rawValue === "" ? undefined : rawValue;
      if (legacyValue !== undefined) values[rawTrimmedKey] = legacyValue;
      warnings.push(`Attribute '${rawTrimmedKey}' has no active definition and was saved as legacy metadata.`);
      continue;
    }
    const normalized = normalizeAttributeValue(rawValue, definition.type);
    if (normalized === undefined) {
      if (definition.required) throw new HttpError(400, `Attribute '${key}' is required`);
      removals.push(key);
      continue;
    }
    if (!validateAttributeValue(normalized, definition.type)) {
      throw new HttpError(400, `Attribute '${key}' must be a valid ${definition.type}`);
    }
    values[key] = normalized;
  }
  if (enforceRequired) {
    for (const definition of definitions || []) {
      if (definition.active && definition.required && values[definition.key] === undefined) {
        throw new HttpError(400, `Attribute '${definition.key}' is required`);
      }
    }
  }
  return { values, removals, warnings };
}

function mergeAttributes(existing, incoming) {
  return { ...toPlainAttributes(existing), ...toPlainAttributes(incoming) };
}

function removeAttributeKeys(existing, keys) {
  const next = toPlainAttributes(existing);
  for (const key of keys || []) delete next[key];
  return next;
}

module.exports = {
  ATTRIBUTE_TYPES,
  normalizeAttributeKey,
  isValidAttributeKey,
  validateAttributeDefinitionPayload,
  normalizeAttributeValue,
  validateAttributeValue,
  normalizeAttributesMap,
  mergeAttributes,
  removeAttributeKeys,
  toPlainAttributes,
};
