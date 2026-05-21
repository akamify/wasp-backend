const repo = require("@modules/platform-settings/repositories/platformAddons.repository");
const { PLATFORM_ADDON_DEFS } = require("@modules/platform-settings/constants/platformAddonKeys");
const { invalidateAddonsCache, getAllPlatformAddons, getPlatformAddonsByCategory } = require("@modules/platform-settings/services/platformAddonsResolver.service");
const { HttpError } = require("@shared/utils/httpError");

function defByKey(key) {
  return PLATFORM_ADDON_DEFS.find((x) => x.key === String(key || "").trim()) || null;
}

function requireDef(key) {
  const def = defByKey(key);
  if (!def) throw new HttpError(400, "Unknown platform addon key");
  return def;
}

async function listAllAddons() {
  return getAllPlatformAddons();
}

async function listAddonsByCategory(category) {
  return getPlatformAddonsByCategory(category);
}

async function updateOneAddon({ key, enabled, actorId }) {
  const def = requireDef(key);
  if (typeof enabled !== "boolean") throw new HttpError(400, "Addon enabled must be boolean");
  const prev = await repo.findByKey(def.key);
  const saved = await repo.upsertByKey({
    key: def.key,
    category: def.category,
    label: def.label,
    description: def.description || "",
    enabled,
    visibleInFrontend: true,
    sortOrder: Number(def.sortOrder || 0),
    metadata: {},
    updatedBy: actorId,
  });
  invalidateAddonsCache();
  return {
    item: {
      key: saved.key,
      category: saved.category,
      label: saved.label,
      description: saved.description || "",
      enabled: !!saved.enabled,
      visibleInFrontend: saved.visibleInFrontend !== false,
      source: "db",
      sortOrder: Number(saved.sortOrder || 0),
      updatedAt: saved.updatedAt,
    },
    changed: prev ? Boolean(prev.enabled) !== Boolean(enabled) : true,
    previousEnabled: prev ? !!prev.enabled : !!def.defaultEnabled,
  };
}

async function bulkUpdateAddons({ updates, actorId }) {
  const out = [];
  for (const row of updates) {
    out.push(await updateOneAddon({ key: row.key, enabled: !!row.enabled, actorId }));
  }
  return out;
}

module.exports = { listAllAddons, listAddonsByCategory, updateOneAddon, bulkUpdateAddons };

