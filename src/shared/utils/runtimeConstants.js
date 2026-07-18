const { appBrandName } = require("@core/config/env");

function BRAND_NAME_FALLBACK() {
  return String(appBrandName || "Ai Wiz Chat").trim() || "Ai Wiz Chat";
}

module.exports = { BRAND_NAME_FALLBACK };

