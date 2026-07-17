const { appBrandName } = require("@core/config/env");

function BRAND_NAME_FALLBACK() {
  return String(appBrandName || "Waspakamify").trim() || "Waspakamify";
}

module.exports = { BRAND_NAME_FALLBACK };

