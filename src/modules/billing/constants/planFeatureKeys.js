const FEATURE_FUNCTIONALITY_KEYS = Object.freeze([
  "campaignApiAccess",
  "externalChatApiAccess",
  "crmAccess",
  "employeeAccess",
  "leadDistributionAccess",
  "analyticsAccess",
  "exportAccess",
  "automationAccess",
  "apiKeyAccess",
]);

const LIMIT_KEYS = Object.freeze([
  "maxContacts",
  "maxTemplates",
  "maxEmployees",
  "maxApiKeys",
  "maxCampaignsPerMonth",
  "maxContactsExport",
  "maxStorageMb",
]);

module.exports = { FEATURE_FUNCTIONALITY_KEYS, LIMIT_KEYS };
