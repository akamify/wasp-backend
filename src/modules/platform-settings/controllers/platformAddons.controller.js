const addonsService = require("@modules/platform-settings/services/platformAddons.service");
const { PLATFORM_ADDON_CATEGORIES } = require("@modules/platform-settings/constants/platformAddonCategories");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { HttpError } = require("@shared/utils/httpError");

async function listAddons(req, res) {
  const items = await addonsService.listAllAddons();
  return res.json({ success: true, items });
}

async function listAddonsByCategory(req, res) {
  const category = String(req.params.category || "").trim();
  if (!Object.values(PLATFORM_ADDON_CATEGORIES).includes(category)) {
    throw new HttpError(400, "Unknown add-on category");
  }
  const items = await addonsService.listAddonsByCategory(category);
  return res.json({ success: true, items });
}

async function updateAddon(req, res) {
  const key = String(req.params.key || "").trim();
  const enabled = !!req.body?.enabled;
  const result = await addonsService.updateOneAddon({
    key,
    enabled,
    actorId: req.user?.id,
  });
  await writeAuditLog(req, {
    action: result.changed
      ? result.item.enabled
        ? "platform_addon.enabled"
        : "platform_addon.disabled"
      : "platform_addon.updated",
    targetId: req.user?.id,
    resourceType: "platform_addon",
    resourceId: result.item.key,
    metadata: {
      key: result.item.key,
      category: result.item.category,
      previousEnabled: !!result.previousEnabled,
      enabled: !!result.item.enabled,
    },
  });
  return res.json({ success: true, item: result.item });
}

async function bulkUpdateAddons(req, res) {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const results = await addonsService.bulkUpdateAddons({
    updates,
    actorId: req.user?.id,
  });
  const items = results.map((x) => x.item);
  await writeAuditLog(req, {
    action: "platform_addon.bulk_updated",
    targetId: req.user?.id,
    resourceType: "platform_addon",
    metadata: {
      count: items.length,
      keys: items.map((x) => x.key),
    },
  });
  return res.json({ success: true, items });
}

module.exports = {
  listAddons,
  listAddonsByCategory,
  updateAddon,
  bulkUpdateAddons,
};
