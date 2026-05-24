const { billingSettingsRepository } = require("@modules/billing/repositories");

const FREE_PLAN_FEATURES = Object.freeze({
  dashboardPageAccess: true,
  templatesPageAccess: true,
  campaignsPageAccess: true,
  contactsPageAccess: true,
  inboxPageAccess: true,
  walletPageAccess: true,
  crmPageAccess: false,
  flowsPageAccess: false,
  linksPageAccess: false,
  automationPageAccess: false,
  activityPageAccess: false,
  apiKeysPageAccess: false,
  apiReportsPageAccess: false,
  campaignApiAccess: false,
  exportAccess: true,
  externalChatApiAccess: false,
  crmAccess: false,
  employeeAccess: false,
  leadDistributionAccess: false,
  analyticsAccess: false,
  automationAccess: false,
  apiKeyAccess: false,
});

const FREE_PLAN_DEFAULTS = Object.freeze({
  name: "Free",
  description: "Starter access with limited usage.",
  buttonText: "Current Plan",
  limits: {
    maxContacts: 10,
    maxTemplates: 5,
    maxCampaignsPerMonth: 3,
    maxContactsExport: 10,
  },
});

const FREE_PLAN_DISPLAY_FEATURES = Object.freeze([
  "Dashboard Page Access",
  "Templates Page Access",
  "Wallet Page Access",
  "Campaigns Page Access",
  "Contacts Page Access",
  "Chat Inbox Page Access",
]);

const FREE_PLAN_UNAVAILABLE_FEATURES = Object.freeze([
  "CRM Page Access",
  "Flows Page Access",
  "Links Page Access",
  "Automation Page Access",
  "Activity Page Access",
  "API Keys Page Access",
  "API Reports Page Access",
  "External Chat API Access",
  "Campaign API Access",
  "Employee Access",
  "Lead Distribution Access",
]);

function normalizeLimit(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

async function getFreePlanConfig() {
  const row = await billingSettingsRepository.getSingleton();
  const configured = row?.freePlan || {};
  return {
    name: String(configured.name || FREE_PLAN_DEFAULTS.name),
    description: String(configured.description || FREE_PLAN_DEFAULTS.description),
    buttonText: String(configured.buttonText || FREE_PLAN_DEFAULTS.buttonText),
    features: { ...FREE_PLAN_FEATURES },
    limits: {
      maxContacts: normalizeLimit(configured?.limits?.maxContacts, FREE_PLAN_DEFAULTS.limits.maxContacts),
      maxTemplates: normalizeLimit(configured?.limits?.maxTemplates, FREE_PLAN_DEFAULTS.limits.maxTemplates),
      maxCampaignsPerMonth: normalizeLimit(
        configured?.limits?.maxCampaignsPerMonth,
        FREE_PLAN_DEFAULTS.limits.maxCampaignsPerMonth
      ),
      maxContactsExport: normalizeLimit(configured?.limits?.maxContactsExport, FREE_PLAN_DEFAULTS.limits.maxContactsExport),
      maxExportsPerMonth: normalizeLimit(
        configured?.limits?.maxContactsExport,
        FREE_PLAN_DEFAULTS.limits.maxContactsExport
      ),
    },
  };
}

module.exports = {
  FREE_PLAN_FEATURES,
  FREE_PLAN_DEFAULTS,
  FREE_PLAN_DISPLAY_FEATURES,
  FREE_PLAN_UNAVAILABLE_FEATURES,
  getFreePlanConfig,
};
