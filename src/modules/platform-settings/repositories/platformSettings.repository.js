const { PlatformSetting } = require("@infra/database/PlatformSetting");

async function findByKey(key) {
  return PlatformSetting.findOne({ key: String(key || "").trim() });
}

async function listAllEnabled() {
  return PlatformSetting.find({ enabled: true }).sort({ category: 1, key: 1 });
}

async function listByCategory(category) {
  return PlatformSetting.find({ enabled: true, category: String(category || "").trim() }).sort({ key: 1 });
}

async function upsertByKey({ key, category, value, valueType, encrypted, masked, description, updatedBy }) {
  return PlatformSetting.findOneAndUpdate(
    { key: String(key || "").trim() },
    {
      $set: {
        category,
        value,
        valueType,
        encrypted: !!encrypted,
        masked: !!masked,
        description: String(description || ""),
        editableBy: "super_admin",
        enabled: true,
        updatedBy: updatedBy || undefined,
      },
    },
    { new: true, upsert: true }
  );
}

module.exports = { findByKey, listAllEnabled, listByCategory, upsertByKey };

