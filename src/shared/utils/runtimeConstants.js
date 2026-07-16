const { appBrandName } = require("@core/config/env");

function BRAND_NAME_FALLBACK() {
  return String(appBrandName || "AiWizChat").trim() || "AiWizChat";
}

module.exports = { BRAND_NAME_FALLBACK };

