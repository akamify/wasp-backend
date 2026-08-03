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
  aiAgentsPageAccess: false,
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
  whatsAppBroadcastAccess: true,
  liveChatAccess: true,
  multiAgentInboxAccess: false,
  clickToWhatsAppAdsAccess: true,
  templateMessageApiAccess: false,
  smartAudienceSegregationAccess: false,
  broadcastRetargetingAccess: false,
  smartCampaignManagerAccess: false,
  campaignSchedulerAccess: false,
  campaignClickTrackingAccess: false,
  csvCampaignSchedulerAccess: false,
  carouselClickTrackingAccess: false,
  automaticFailedRetryAccess: false,
  smartAgentRoutingAccess: false,
  customAgentRulesAccess: false,
  projectApiAccess: false,
  webhookAccess: false,
  webhookApiAccess: false,
  developerApiAccess: false,
  templateTtlAccess: false,
  downloadReportsAccess: false,
  numberMaskingAccess: false,
  duplicateCsvContactsAccess: false,
  multiCtwaChatflowTriggerAccess: false,
  chatflowDelayAccess: false,
  chatflowTimeoutAccess: false,
  prioritySupportAccess: false,
  turboOnboardingAccess: false,
  dedicatedAccountManagerAccess: false,
  userAccessControlAccess: false,
  whiteLabelAccess: false,
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
    maxAgents: 0,
    maxTags: 10,
    maxCustomAttributes: 5,
    maxWebhooks: 0,
    messageRatePerSec: 5,
    maxFlows: 0,
    maxTeams: 0,
    maxApiKeys: 0,
    maxStorageMb: 0,
    maxProjects: 0,
    maxMediaSizeMb: 0,
    dailyMessageLimit: 0,
  },
});

const FREE_PLAN_DISPLAY_FEATURES = Object.freeze([
  "Dashboard Page Access",
  "Templates Page Access",
  "Wallet Page Access",
  "Campaigns Page Access",
  "Contacts Page Access",
  "Chat Inbox Page Access",
  "Click-to-WhatsApp Ads Manager",
  "Up to 10 Tags & 5 Custom Attributes",
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
  "Campaign Scheduler",
  "Project APIs",
  "Download Reports",
  "Number Masking",
]);

function normalizeLimit(v, fallback) {
  if (v === null) return null;
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
      maxAgents: normalizeLimit(configured?.limits?.maxAgents, FREE_PLAN_DEFAULTS.limits.maxAgents),
      maxEmployees: normalizeLimit(configured?.limits?.maxAgents, FREE_PLAN_DEFAULTS.limits.maxAgents),
      maxTags: normalizeLimit(configured?.limits?.maxTags, FREE_PLAN_DEFAULTS.limits.maxTags),
      maxCustomAttributes: normalizeLimit(configured?.limits?.maxCustomAttributes, FREE_PLAN_DEFAULTS.limits.maxCustomAttributes),
      maxWebhooks: normalizeLimit(configured?.limits?.maxWebhooks, FREE_PLAN_DEFAULTS.limits.maxWebhooks),
      messageRatePerSec: normalizeLimit(configured?.limits?.messageRatePerSec, FREE_PLAN_DEFAULTS.limits.messageRatePerSec),
      maxFlows: normalizeLimit(configured?.limits?.maxFlows, FREE_PLAN_DEFAULTS.limits.maxFlows),
      maxTeams: normalizeLimit(configured?.limits?.maxTeams, FREE_PLAN_DEFAULTS.limits.maxTeams),
      maxApiKeys: normalizeLimit(configured?.limits?.maxApiKeys, FREE_PLAN_DEFAULTS.limits.maxApiKeys),
      maxStorageMb: normalizeLimit(configured?.limits?.maxStorageMb, FREE_PLAN_DEFAULTS.limits.maxStorageMb),
      maxProjects: normalizeLimit(configured?.limits?.maxProjects, FREE_PLAN_DEFAULTS.limits.maxProjects),
      maxMediaSizeMb: normalizeLimit(configured?.limits?.maxMediaSizeMb, FREE_PLAN_DEFAULTS.limits.maxMediaSizeMb),
      dailyMessageLimit: normalizeLimit(configured?.limits?.dailyMessageLimit, FREE_PLAN_DEFAULTS.limits.dailyMessageLimit),
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
