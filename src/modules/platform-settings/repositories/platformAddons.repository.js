const { PlatformAddon } = require("@infra/database/PlatformAddon");

async function findByKey(key) {
  return PlatformAddon.findOne({ key: String(key || "").trim(), deletedAt: null });
}

async function listAll() {
  return PlatformAddon.find({ deletedAt: null }).sort({ category: 1, sortOrder: 1, key: 1 });
}

async function listByCategory(category) {
  return PlatformAddon.find({ category: String(category || "").trim(), deletedAt: null }).sort({ sortOrder: 1, key: 1 });
}

async function upsertByKey(payload) {
  return PlatformAddon.findOneAndUpdate(
    { key: String(payload.key || "").trim() },
    {
      $set: {
        category: payload.category,
        label: payload.label,
        description: payload.description || "",
        enabled: !!payload.enabled,
        visibleInFrontend: payload.visibleInFrontend !== false,
        sortOrder: Number(payload.sortOrder || 0),
        metadata: payload.metadata || {},
        editableBy: "super_admin",
        updatedBy: payload.updatedBy || undefined,
        deletedAt: null,
        deletedBy: null,
      },
    },
    { new: true, upsert: true }
  );
}

module.exports = { findByKey, listAll, listByCategory, upsertByKey };

