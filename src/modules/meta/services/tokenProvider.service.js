const { decryptString } = require("@shared/utils/crypto");
const { HttpError } = require("@shared/utils/httpError");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const settingsResolver = require("@modules/platform-settings/services/platformSettingsResolver.service");
const { PLATFORM_SETTING_KEYS } = require("@modules/platform-settings/constants/platformSettingKeys");

const META_TOKEN_TYPES = Object.freeze({
  APP_ACCESS: "APP_ACCESS",
  SYSTEM_USER: "SYSTEM_USER",
  EMBEDDED_SIGNUP_CUSTOMER: "EMBEDDED_SIGNUP_CUSTOMER",
});

async function getSystemUserAccessToken() {
  const result = await settingsResolver.getSettingWithMeta(
    PLATFORM_SETTING_KEYS.SYSTEM_USER_ACCESS_TOKEN
  );
  const fallback = String(process.env.SYSTEM_USER_ACCESS_TOKEN || "").trim();
  const normalized = String(
    result?.value == null || result.value === "" ? fallback : result.value
  ).trim();
  if (!normalized) {
    throw new HttpError(500, "Missing Meta system user access token.");
  }
  return normalized;
}

async function getSystemUserAccessTokenDiagnostics() {
  const result = await settingsResolver.getSettingWithMeta(
    PLATFORM_SETTING_KEYS.SYSTEM_USER_ACCESS_TOKEN
  );
  const fallback = String(process.env.SYSTEM_USER_ACCESS_TOKEN || "").trim();
  const normalized = String(
    result?.value == null || result.value === "" ? fallback : result.value
  ).trim();

  return {
    present: Boolean(normalized),
    source:
      result?.value == null || result.value === ""
        ? fallback
          ? "env"
          : "missing"
        : result?.source || "db",
    length: normalized.length,
    fingerprint: normalized
      ? `${normalized.slice(0, 4)}...${normalized.slice(-4)}`
      : null,
  };
}

function getAppAccessToken() {
  const { metaAppId, metaAppSecret } = getMetaAppConfig();
  return `${metaAppId}|${metaAppSecret}`;
}

function getEmbeddedSignupCustomerToken({ token, connectionDoc }) {
  const direct = String(token || "").trim();
  if (direct) return direct;
  if (connectionDoc?.accessTokenEnc) return decryptString(connectionDoc.accessTokenEnc);
  throw new HttpError(500, "Missing embedded signup customer token.");
}

async function getToken({ tokenType, token, connectionDoc } = {}) {
  switch (tokenType) {
    case META_TOKEN_TYPES.SYSTEM_USER:
      return getSystemUserAccessToken();
    case META_TOKEN_TYPES.APP_ACCESS:
      return getAppAccessToken();
    case META_TOKEN_TYPES.EMBEDDED_SIGNUP_CUSTOMER:
      return getEmbeddedSignupCustomerToken({ token, connectionDoc });
    default:
      throw new HttpError(500, `Unsupported Meta token type: ${String(tokenType || "unknown")}`);
  }
}

module.exports = {
  META_TOKEN_TYPES,
  getToken,
  getSystemUserAccessTokenDiagnostics,
};
