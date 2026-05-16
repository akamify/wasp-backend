const crypto = require("crypto");

function generateApiKeyRaw() {
  const token = crypto.randomBytes(32).toString("hex");
  return `wpk_live_${token}`;
}

module.exports = { generateApiKeyRaw };
