const crypto = require("crypto");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");

async function getMetaSecretFingerprint(req, res) {
  const { metaAppId, metaAppSecret } = getMetaAppConfig();
  const secretTestHmac = crypto
    .createHmac("sha256", metaAppSecret)
    .update("digitalwasp-secret-check-v1")
    .digest("hex");

  return res.json({
    success: true,
    metaAppId,
    metaAppSecretLength: metaAppSecret.length,
    secretTestHmac,
  });
}

module.exports = { getMetaSecretFingerprint };
