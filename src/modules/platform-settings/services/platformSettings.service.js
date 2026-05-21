const repo = require("@modules/platform-settings/repositories/platformSettings.repository");
const { PLATFORM_SETTING_DEFS } = require("@modules/platform-settings/constants/platformSettingKeys");
const { parseSettingValue } = require("@modules/platform-settings/utils/parseSettingValue");
const { maskSecret } = require("@modules/platform-settings/utils/maskSecret");
const { maybeEncryptForStorage } = require("@modules/platform-settings/services/platformSettingsSecret.service");
const { invalidateSettingsCache, getSettingWithMeta } = require("@modules/platform-settings/services/platformSettingsResolver.service");
const { HttpError } = require("@shared/utils/httpError");

function getDefOrThrow(key) {
  const def = PLATFORM_SETTING_DEFS[String(key || "").trim()];
  if (!def) throw new HttpError(400, "Unknown platform setting key");
  return def;
}

function redactForAudit(def, value) {
  if (String(def?.valueType || "") === "secret") return maskSecret(value);
  return value;
}

async function getAllSettings() {
  const keys = Object.keys(PLATFORM_SETTING_DEFS);
  const out = [];
  for (const key of keys) {
    const def = PLATFORM_SETTING_DEFS[key];
    const row = await repo.findByKey(key);
    const resolved = await getSettingWithMeta(key);
    out.push({
      key,
      category: def.category,
      valueType: def.valueType,
      masked: !!def.masked,
      value: def.masked ? maskSecret(String(resolved.value || "")) : resolved.value,
      hasValue: resolved.value != null && String(resolved.value) !== "",
      source: resolved.source,
      runtimeEffect: def.runtimeEffect || "LIVE",
      requiresConfirm: !!def.requiresConfirm,
      enabled: row ? !!row.enabled : true,
      description: String(row?.description || ""),
      editableBy: "super_admin",
    });
  }
  return out;
}

async function updateOneSetting({ key, value, confirmReplaceSecret, actorId }) {
  const def = getDefOrThrow(key);
  if (String(def.valueType) === "secret" && def.requiresConfirm && !confirmReplaceSecret) {
    throw new HttpError(400, "Confirmation required to replace this secret");
  }
  const parsedValue = parseSettingValue(value, def);
  const previous = await getSettingWithMeta(key);
  const previousAudit = redactForAudit(def, previous.value);
  const { storedValue, encrypted } = maybeEncryptForStorage(def, parsedValue);
  const saved = await repo.upsertByKey({
    key,
    category: def.category,
    value: storedValue,
    valueType: def.valueType,
    encrypted,
    masked: !!def.masked,
    description: def.description || "",
    updatedBy: actorId,
  });
  invalidateSettingsCache();
  const nextResolved = await getSettingWithMeta(key);
  const nextAudit = redactForAudit(def, nextResolved.value);
  return {
    item: {
      key,
      category: def.category,
      valueType: def.valueType,
      masked: !!def.masked,
      value: def.masked ? maskSecret(String(nextResolved.value || "")) : nextResolved.value,
      source: nextResolved.source,
      runtimeEffect: def.runtimeEffect || "LIVE",
      requiresConfirm: !!def.requiresConfirm,
      updatedAt: saved.updatedAt,
    },
    audit: { oldValue: previousAudit, newValue: nextAudit, isSecret: def.valueType === "secret" },
  };
}

async function bulkUpdateSettings({ updates, actorId }) {
  const results = [];
  for (const u of updates) {
    const x = await updateOneSetting({
      key: u.key,
      value: u.value,
      confirmReplaceSecret: !!u.confirmReplaceSecret,
      actorId,
    });
    results.push(x.item);
  }
  return results;
}

module.exports = { getAllSettings, updateOneSetting, bulkUpdateSettings };

