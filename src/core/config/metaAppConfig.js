function getMetaAppConfig() {
  const metaAppIdRaw = process.env.META_APP_ID || process.env.APP_ID || "";
  const metaAppSecretRaw = process.env.META_APP_SECRET || process.env.APP_SECRET || "";
  const metaAppId = String(metaAppIdRaw || "").trim();
  const metaAppSecret = String(metaAppSecretRaw || "").trim();

  if (!metaAppId) throw new Error("Missing META_APP_ID or APP_ID");
  if (!metaAppSecret) throw new Error("Missing META_APP_SECRET or APP_SECRET");

  return {
    metaAppId,
    metaAppSecret,
    metaAppSecretSource: process.env.META_APP_SECRET ? "META_APP_SECRET" : "APP_SECRET",
  };
}

module.exports = { getMetaAppConfig };
