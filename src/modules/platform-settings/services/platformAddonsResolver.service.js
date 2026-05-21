const repo = require("@modules/platform-settings/repositories/platformAddons.repository");
const { PLATFORM_ADDON_DEFS } = require("@modules/platform-settings/constants/platformAddonKeys");

const TTL_MS = 15 * 1000;
const cache = { expiresAt: 0, byKey: new Map() };

async function refreshCache() {
  if (Date.now() < cache.expiresAt && cache.byKey.size) return;
  try {
    const rows = await repo.listAll();
    const map = new Map();
    rows.forEach((r) => map.set(String(r.key), r));
    cache.byKey = map;
  } catch {
    cache.byKey = new Map();
  } finally {
    cache.expiresAt = Date.now() + TTL_MS;
  }
}

function invalidateAddonsCache() {
  cache.expiresAt = 0;
  cache.byKey = new Map();
}

async function isPlatformAddonEnabled(key) {
  const k = String(key || "").trim();
  await refreshCache();
  const row = cache.byKey.get(k);
  if (row) return !!row.enabled;
  const def = PLATFORM_ADDON_DEFS.find((x) => x.key === k);
  return !!def?.defaultEnabled;
}

async function getAllPlatformAddons() {
  await refreshCache();
  return PLATFORM_ADDON_DEFS.map((def) => {
    const row = cache.byKey.get(def.key);
    return {
      key: def.key,
      category: def.category,
      label: def.label,
      description: def.description || "",
      enabled: row ? !!row.enabled : !!def.defaultEnabled,
      visibleInFrontend: row ? row.visibleInFrontend !== false : true,
      sortOrder: row ? Number(row.sortOrder || 0) : Number(def.sortOrder || 0),
      source: row ? "db" : "default",
    };
  }).sort((a, b) => String(a.category).localeCompare(String(b.category)) || Number(a.sortOrder) - Number(b.sortOrder));
}

async function getPlatformAddonsByCategory(category) {
  const c = String(category || "").trim();
  const all = await getAllPlatformAddons();
  return all.filter((x) => x.category === c);
}

module.exports = {
  invalidateAddonsCache,
  isPlatformAddonEnabled,
  getAllPlatformAddons,
  getPlatformAddonsByCategory,
};

