const { sendEmail } = require("@shared/services/emailService");
const { PLATFORM_SETTING_KEYS } = require("@modules/platform-settings/constants/platformSettingKeys");
const resolver = require("@modules/platform-settings/services/platformSettingsResolver.service");

async function testEmailSettings(toEmail) {
  const fromEmail = await resolver.getSetting(PLATFORM_SETTING_KEYS.BREVO_SENDER_EMAIL, process.env.BREVO_SENDER_EMAIL || "");
  const result = await sendEmail({
    toEmail,
    toName: "",
    subject: "Platform settings test email",
    htmlContent: "<p>Brevo platform settings test successful.</p>",
    textContent: "Brevo platform settings test successful.",
    senderOverride: {
      email: fromEmail || undefined,
      name: await resolver.getSetting(PLATFORM_SETTING_KEYS.BREVO_SENDER_NAME, process.env.BREVO_SENDER_NAME || ""),
      apiKey: await resolver.getSettingSecret(PLATFORM_SETTING_KEYS.BREVO_API_KEY, process.env.BREVO_API_KEY || ""),
    },
  });
  return result;
}

async function testMetaSettings() {
  const checks = {
    appId: !!(await resolver.getSetting(PLATFORM_SETTING_KEYS.APP_ID, process.env.APP_ID || process.env.META_APP_ID || "")),
    appSecret: !!(await resolver.getSettingSecret(PLATFORM_SETTING_KEYS.APP_SECRET, process.env.APP_SECRET || process.env.META_APP_SECRET || "")),
    verifyToken: !!(await resolver.getSettingSecret(PLATFORM_SETTING_KEYS.META_WEBHOOK_VERIFY_TOKEN, process.env.META_WEBHOOK_VERIFY_TOKEN || "")),
    graphVersion: !!(await resolver.getSetting(PLATFORM_SETTING_KEYS.META_GRAPH_VERSION, process.env.META_GRAPH_VERSION || "v22.0")),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

async function testRazorpaySettings() {
  const checks = {
    keyId: !!(await resolver.getSetting(PLATFORM_SETTING_KEYS.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_ID || "")),
    keySecret: !!(await resolver.getSettingSecret(PLATFORM_SETTING_KEYS.RAZORPAY_KEY_SECRET, process.env.RAZORPAY_KEY_SECRET || "")),
    webhookSecret: !!(await resolver.getSettingSecret(PLATFORM_SETTING_KEYS.RAZORPAY_WEBHOOK_SECRET, process.env.RAZORPAY_WEBHOOK_SECRET || "")),
  };
  return { ok: Object.values(checks).every(Boolean), checks };
}

module.exports = { testEmailSettings, testMetaSettings, testRazorpaySettings };

