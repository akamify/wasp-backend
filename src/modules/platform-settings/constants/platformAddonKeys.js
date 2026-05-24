const { PLATFORM_ADDON_CATEGORIES } = require("@modules/platform-settings/constants/platformAddonCategories");

const PLATFORM_ADDON_KEYS = {
  CRM_MODULE: "crmModule",
  EXTERNAL_CHAT_API: "externalChatApi",
  CAMPAIGN_API: "campaignApi",
  BREVO_EMAIL: "brevoEmail",
  RAZORPAY_PAYMENTS: "razorpayPayments",
  META_INTEGRATION: "metaIntegration",
  PUBLIC_SIGNUP: "publicSignup",
  EXPORTS: "exports",
  DEBUG_FEED: "debugFeed",
  MAINTENANCE_MODE: "maintenanceMode",
  EMPLOYEE_CRM_MODULE: "employeeCrmModule",
};

const PLATFORM_ADDON_DEFS = [
  { key: PLATFORM_ADDON_KEYS.CRM_MODULE, category: PLATFORM_ADDON_CATEGORIES.CORE, label: "CRM available", description: "Global CRM availability toggle", defaultEnabled: true, sortOrder: 10 },
  { key: PLATFORM_ADDON_KEYS.EXTERNAL_CHAT_API, category: PLATFORM_ADDON_CATEGORIES.CORE, label: "External Chat API available", description: "Enable external chat API surfaces", defaultEnabled: false, sortOrder: 20 },
  { key: PLATFORM_ADDON_KEYS.CAMPAIGN_API, category: PLATFORM_ADDON_CATEGORIES.CORE, label: "Campaign API available", description: "Enable campaign API endpoints for platform", defaultEnabled: true, sortOrder: 30 },
  { key: PLATFORM_ADDON_KEYS.BREVO_EMAIL, category: PLATFORM_ADDON_CATEGORIES.INTEGRATIONS, label: "Brevo email enabled", description: "Enable platform email provider usage", defaultEnabled: true, sortOrder: 40 },
  { key: PLATFORM_ADDON_KEYS.RAZORPAY_PAYMENTS, category: PLATFORM_ADDON_CATEGORIES.INTEGRATIONS, label: "Razorpay payments enabled", description: "Enable recharge/payment flows", defaultEnabled: true, sortOrder: 50 },
  { key: PLATFORM_ADDON_KEYS.META_INTEGRATION, category: PLATFORM_ADDON_CATEGORIES.INTEGRATIONS, label: "Meta integration enabled", description: "Enable WhatsApp Meta integration actions", defaultEnabled: true, sortOrder: 60 },
  { key: PLATFORM_ADDON_KEYS.DEBUG_FEED, category: PLATFORM_ADDON_CATEGORIES.OPERATIONS, label: "Debug feed enabled", description: "Enable debug feed surfaces", defaultEnabled: false, sortOrder: 70 },
  { key: PLATFORM_ADDON_KEYS.PUBLIC_SIGNUP, category: PLATFORM_ADDON_CATEGORIES.ACCESS, label: "Public signup enabled", description: "Allow public registration", defaultEnabled: true, sortOrder: 80 },
  { key: PLATFORM_ADDON_KEYS.MAINTENANCE_MODE, category: PLATFORM_ADDON_CATEGORIES.OPERATIONS, label: "Maintenance mode enabled", description: "Platform maintenance mode visibility", defaultEnabled: false, sortOrder: 90 },
  { key: PLATFORM_ADDON_KEYS.EMPLOYEE_CRM_MODULE, category: PLATFORM_ADDON_CATEGORIES.CORE, label: "Employee CRM module enabled", description: "Enable employee CRM app access", defaultEnabled: true, sortOrder: 100 },
  { key: PLATFORM_ADDON_KEYS.EXPORTS, category: PLATFORM_ADDON_CATEGORIES.CORE, label: "Exports enabled", description: "Allow export actions", defaultEnabled: true, sortOrder: 110 },
];

module.exports = { PLATFORM_ADDON_KEYS, PLATFORM_ADDON_DEFS };

