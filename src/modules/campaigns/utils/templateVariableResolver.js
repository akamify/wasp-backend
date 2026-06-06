const CONTACT_FIELDS = new Set(["name", "phone", "email", "company", "language"]);

function getContactAttribute(contact, key) {
  if (contact?.attributes instanceof Map) return contact.attributes.get(key);
  return contact?.attributes?.[key];
}

function resolveMappingValue(contact, mapping) {
  if (mapping.sourceType === "static") return mapping.value;
  if (mapping.sourceType === "contact_field" && CONTACT_FIELDS.has(mapping.sourceKey)) {
    return contact?.[mapping.sourceKey];
  }
  if (mapping.sourceType === "contact_attribute") {
    return getContactAttribute(contact, mapping.sourceKey);
  }
  return undefined;
}

function resolveTemplateVariablesForContact(contact, mappings) {
  const sorted = [...(mappings || [])].sort((a, b) => Number(a.position) - Number(b.position));
  const values = [];
  const missing = [];
  for (const mapping of sorted) {
    let value = resolveMappingValue(contact, mapping);
    if (value === null || value === undefined || String(value).trim() === "") value = mapping.fallback;
    if (value === null || value === undefined || String(value).trim() === "") {
      missing.push({
        position: Number(mapping.position),
        sourceType: mapping.sourceType,
        sourceKey: mapping.sourceKey,
      });
      values[Number(mapping.position) - 1] = "";
      continue;
    }
    values[Number(mapping.position) - 1] = String(value);
  }
  return { values, missing };
}

function resolveRecipientRuntime({ contact, recipient, mappings }) {
  const body = mappings?.body?.length
    ? resolveTemplateVariablesForContact(contact, mappings.body)
    : { values: recipient.variables || [], missing: [] };
  const header = mappings?.header?.length
    ? resolveTemplateVariablesForContact(contact, mappings.header)
    : { values: recipient.headerVariables || [], missing: [] };
  const buttons = mappings?.button?.length
    ? resolveTemplateVariablesForContact(contact, mappings.button)
    : { values: recipient.buttonValues || [], missing: [] };
  return {
    recipient: {
      ...recipient,
      variables: body.values,
      headerVariables: header.values,
      buttonValues: buttons.values,
    },
    missing: [...body.missing, ...header.missing, ...buttons.missing],
  };
}

module.exports = { resolveTemplateVariablesForContact, resolveRecipientRuntime };
