const repo = require("@modules/platform-settings/repositories/platformSettings.repository");
const { PLATFORM_SETTING_DEFS } = require("@modules/platform-settings/constants/platformSettingKeys");
const { decryptString } = require("@shared/utils/crypto");

const TTL_MS = 20 * 1000;
const cache = { expiresAt: 0, byKey: new Map() };

function parseEnvValue(raw, valueType) {
  if (valueType === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (valueType === "boolean") {
    return ["true", "1", "yes", "on"].includes(String(raw || "").toLowerCase());
  }
  return raw == null ? "" : String(raw);
}

async function refreshCache() {
  if (Date.now() < cache.expiresAt && cache.byKey.size) return;
  try {
    const rows = await repo.listAllEnabled();
    const map = new Map();
    rows.forEach((r) => map.set(String(r.key), r));
    cache.byKey = map;
  } catch {
    cache.byKey = new Map();
  } finally {
    cache.expiresAt = Date.now() + TTL_MS;
  }
}

function invalidateSettingsCache() {
  cache.expiresAt = 0;
  cache.byKey = new Map();
}

async function getSettingWithMeta(key) {
  const k = String(key || "").trim();
  const def = PLATFORM_SETTING_DEFS[k];
  if (!def) return { value: undefined, source: "default", runtimeEffect: "LIVE", def: null };
  if (k === "AUTH_DEV_RETURN_EMAIL_TOKENS" && String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return { value: false, source: "default", runtimeEffect: def.runtimeEffect || "RESTART_REQUIRED", def };
  }

  await refreshCache();
  const row = cache.byKey.get(k);
  if (row && row.enabled) {
    let dbValue = row.value;
    if (row.encrypted && typeof dbValue === "string") {
      try {
        dbValue = decryptString(dbValue);
      } catch {
        dbValue = "";
      }
    }
    return { value: dbValue, source: "db", runtimeEffect: def.runtimeEffect || "LIVE", def };
  }

  const envRaw = process.env[k];
  if (envRaw != null && String(envRaw).trim() !== "") {
    return {
      value: parseEnvValue(envRaw, def.valueType),
      source: "env",
      runtimeEffect: def.runtimeEffect || "LIVE",
      def,
    };
  }
  return { value: undefined, source: "default", runtimeEffect: def.runtimeEffect || "LIVE", def };
}

async function getSetting(key, fallback = "") {
  const r = await getSettingWithMeta(key);
  return r.value == null || r.value === "" ? fallback : r.value;
}

async function getSettingNumber(key, fallback = 0) {
  const r = await getSettingWithMeta(key);
  const n = Number(r.value);
  return Number.isFinite(n) ? n : fallback;
}

async function getSettingBoolean(key, fallback = false) {
  const r = await getSettingWithMeta(key);
  if (typeof r.value === "boolean") return r.value;
  if (r.value == null || r.value === "") return fallback;
  return ["true", "1", "yes", "on"].includes(String(r.value).toLowerCase());
}

async function getSettingSecret(key, fallback = "") {
  const r = await getSettingWithMeta(key);
  return r.value == null || r.value === "" ? fallback : String(r.value);
}

async function getSettingsByCategory(category) {
  const c = String(category || "").trim();
  const keys = Object.keys(PLATFORM_SETTING_DEFS).filter((k) => PLATFORM_SETTING_DEFS[k]?.category === c);
  const out = [];
  for (const key of keys) {
    const v = await getSettingWithMeta(key);
    out.push({
      key,
      category: c,
      value: v.value,
      valueType: v.def?.valueType || "string",
      masked: !!v.def?.masked,
      source: v.source,
      runtimeEffect: v.runtimeEffect,
    });
  }
  return out;
}

module.exports = {
  invalidateSettingsCache,
  getSettingWithMeta,
  getSetting,
  getSettingNumber,
  getSettingBoolean,
  getSettingSecret,
  getSettingsByCategory,
};
