const settingsService = require("@modules/platform-settings/services/platformSettings.service");
const settingsTestService = require("@modules/platform-settings/services/platformSettingsTest.service");
const { PLATFORM_SETTING_CATEGORIES } = require("@modules/platform-settings/constants/platformSettingCategories");
const { writeAuditLog } = require("@shared/services/auditLog.service");
const { HttpError } = require("@shared/utils/httpError");

async function listSettings(req, res) {
  const items = await settingsService.getAllSettings();
  return res.json({ success: true, items });
}

async function listSettingsByCategory(req, res) {
  const category = String(req.params.category || "").trim();
  if (!Object.values(PLATFORM_SETTING_CATEGORIES).includes(category)) throw new HttpError(400, "Unknown category");
  const items = (await settingsService.getAllSettings()).filter((x) => x.category === category);
  return res.json({ success: true, items });
}

async function updateSetting(req, res) {
  const key = String(req.params.key || "").trim();
  const { value, confirmReplaceSecret } = req.body || {};
  const { item, audit } = await settingsService.updateOneSetting({
    key,
    value,
    confirmReplaceSecret: !!confirmReplaceSecret,
    actorId: req.user?.id,
  });
  await writeAuditLog(req, {
    action: audit.isSecret ? "platform_setting.secret_replaced" : "platform_setting.updated",
    targetId: req.user?.id,
    resourceType: "platform_setting",
    resourceId: key,
    metadata: {
      key,
      category: item.category,
      oldValue: audit.oldValue,
      newValue: audit.newValue,
      runtimeEffect: item.runtimeEffect,
    },
  });
  return res.json({ success: true, item });
}

async function bulkUpdateSettings(req, res) {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  const items = await settingsService.bulkUpdateSettings({ updates, actorId: req.user?.id });
  await writeAuditLog(req, {
    action: "platform_setting.bulk_updated",
    targetId: req.user?.id,
    resourceType: "platform_setting",
    metadata: { count: items.length, keys: items.map((x) => x.key) },
  });
  return res.json({ success: true, items });
}

async function testCategory(req, res) {
  const category = String(req.params.category || "").trim();
  if (category === "email") {
    const toEmail = String(req.body?.toEmail || "").trim();
    const result = await settingsTestService.testEmailSettings(toEmail);
    await writeAuditLog(req, {
      action: "platform_setting.test_email_sent",
      targetId: req.user?.id,
      resourceType: "platform_setting",
      metadata: { toEmail, sent: !!result?.sent, failed: !!result?.failed },
    });
    return res.json({ success: !!result?.sent, result });
  }
  if (category === "meta") {
    const result = await settingsTestService.testMetaSettings();
    await writeAuditLog(req, {
      action: "platform_setting.meta_tested",
      targetId: req.user?.id,
      resourceType: "platform_setting",
      metadata: result?.checks || {},
    });
    return res.json({ success: !!result?.ok, result });
  }
  if (category === "razorpay") {
    const result = await settingsTestService.testRazorpaySettings();
    await writeAuditLog(req, {
      action: "platform_setting.razorpay_tested",
      targetId: req.user?.id,
      resourceType: "platform_setting",
      metadata: result?.checks || {},
    });
    return res.json({ success: !!result?.ok, result });
  }
  throw new HttpError(400, "Unknown test category");
}

module.exports = {
  listSettings,
  listSettingsByCategory,
  updateSetting,
  bulkUpdateSettings,
  testCategory,
};

