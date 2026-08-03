const axios = require("axios");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { getToken, META_TOKEN_TYPES } = require("@modules/meta/services/tokenProvider.service");
const { findLatestConnectionDocument } = require("@shared/services/whatsappConnectionService");
const { decryptString } = require("@shared/utils/crypto");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function mask(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 3)}***${s.slice(-3)}`;
}

function normalizeMetaError(err) {
  return {
    message:
      err?.response?.data?.error?.message ||
      err?.message ||
      "Meta request failed",
    code: err?.response?.data?.error?.code || null,
    subcode: err?.response?.data?.error?.error_subcode || null,
    fbtrace_id: err?.response?.data?.error?.fbtrace_id || null,
    status: err?.response?.status || null,
  };
}

async function metaSubscriptionHealth(req, res) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const [connectionDoc, credsDoc] = await Promise.all([
    findLatestConnectionDocument(
      req.workspace.id,
      "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc graphApiVersion phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain onboardingStage registrationStatus"
    ),
    WhatsAppCredentials.findOne({ workspaceId: req.workspace.id, isActive: { $ne: false } }).select("lastWebhookAt lastWebhookField lastWebhookObject"),
  ]);
  if (!connectionDoc) {
    return res.json({
      success: true,
      healthy: false,
      checks: { credentialsLoaded: false },
      issues: ["No WhatsApp onboarding record found for this workspace."],
      webhook: {
        lastWebhookAt: credsDoc?.lastWebhookAt ? credsDoc.lastWebhookAt.toISOString() : null,
        lastWebhookField: credsDoc?.lastWebhookField || null,
        lastWebhookObject: credsDoc?.lastWebhookObject || null,
      },
    });
  }

  const creds = {
    accessToken: connectionDoc.accessTokenEnc ? decryptString(connectionDoc.accessTokenEnc) : "",
    phoneNumberId: String(connectionDoc.phoneNumberId || connectionDoc.phoneNumberIdPlain || "").trim(),
    wabaId: String(connectionDoc.wabaId || connectionDoc.businessAccountIdPlain || "").trim(),
    graphApiVersion: connectionDoc.graphApiVersion,
  };
  const baseURL = graphBaseUrl(creds.graphApiVersion);
  const client = axios.create({ baseURL, timeout: 20000 });
  const systemUserToken = await getToken({ tokenType: META_TOKEN_TYPES.SYSTEM_USER });
  const headers = { Authorization: `Bearer ${systemUserToken}` };
  let appId = "";
  let appSecret = "";
  try {
    const cfg = getMetaAppConfig();
    appId = cfg.metaAppId;
    appSecret = cfg.metaAppSecret;
  } catch {}

  const [subsRes, phoneRes, wabaPhonesRes, debugTokenRes] = await Promise.allSettled([
    client.get(`/${creds.wabaId}/subscribed_apps`, { headers }),
    client.get(`/${creds.phoneNumberId}`, {
      headers,
      params: { fields: "id,display_phone_number,verified_name,status,quality_rating" },
    }),
    client.get(`/${creds.wabaId}/phone_numbers`, { headers, params: { limit: 200 } }),
    appId && appSecret && creds.accessToken
      ? client.get("/debug_token", {
          headers,
          params: {
            input_token: creds.accessToken,
          },
        })
      : Promise.resolve({ data: null }),
  ]);

  const subscribedApps =
    subsRes.status === "fulfilled" ? (subsRes.value?.data?.data || []) : [];
  const subscribedAppIds = subscribedApps
    .map((item) =>
      String(
        item?.whatsapp_business_api_data?.id ||
          item?.whatsapp_business_api_data?.app_id ||
          item?.app_id ||
          item?.id ||
          ""
      ).trim()
    )
    .filter(Boolean);
  const isAppSubscribed = appId ? subscribedAppIds.includes(String(appId)) : subscribedAppIds.length > 0;

  const phoneData = phoneRes.status === "fulfilled" ? phoneRes.value.data : null;
  const wabaPhones =
    wabaPhonesRes.status === "fulfilled" ? (wabaPhonesRes.value?.data?.data || []) : [];
  const isPhoneInWaba = wabaPhones.some((p) => String(p?.id || "") === String(creds.phoneNumberId));

  const tokenData = debugTokenRes.status === "fulfilled" ? debugTokenRes.value?.data?.data || null : null;
  const scopes = Array.isArray(tokenData?.scopes) ? tokenData.scopes : [];
  const requiredScopes = ["business_management", "whatsapp_business_management", "whatsapp_business_messaging"];
  const missingScopes = requiredScopes.filter((scope) => !scopes.includes(scope));

  const checks = {
    credentialsLoaded: true,
    appIdConfigured: !!appId,
    appSecretConfigured: !!appSecret,
    appSubscribedToWaba: isAppSubscribed,
    phoneMappedInWaba: isPhoneInWaba,
    requiredScopesPresent: missingScopes.length === 0,
    webhookVerifyTokenConfigured: Boolean(process.env.META_WEBHOOK_VERIFY_TOKEN),
  };

  const issues = [];
  if (!checks.appIdConfigured) issues.push("APP_ID or META_APP_ID is missing in backend env.");
  if (!checks.appSecretConfigured) issues.push("APP_SECRET or META_APP_SECRET is missing in backend env.");
  if (!checks.appSubscribedToWaba) issues.push("This app is not subscribed to the current WABA.");
  if (!checks.phoneMappedInWaba) issues.push("Configured phone_number_id does not appear in this WABA.");
  if (!checks.requiredScopesPresent) issues.push(`Token missing scopes: ${missingScopes.join(", ")}`);
  if (!checks.webhookVerifyTokenConfigured) issues.push("META_WEBHOOK_VERIFY_TOKEN is missing in backend env.");

  return res.json({
    success: true,
    healthy: issues.length === 0,
    checks,
    issues,
    lifecycle: {
      onboardingStage: connectionDoc.onboardingStage || null,
      registrationStatus: connectionDoc.registrationStatus || null,
    },
    webhook: {
      lastWebhookAt: credsDoc?.lastWebhookAt ? credsDoc.lastWebhookAt.toISOString() : null,
      lastWebhookField: credsDoc?.lastWebhookField || null,
      lastWebhookObject: credsDoc?.lastWebhookObject || null,
    },
    config: {
      graphApiVersion: creds.graphApiVersion,
      wabaId: mask(creds.wabaId),
      phoneNumberId: mask(creds.phoneNumberId),
      appId: appId ? mask(appId) : "",
    },
    phone: phoneData,
    subscribedApps: {
      count: subscribedApps.length,
      appIds: subscribedAppIds.map(mask),
    },
    token: tokenData
      ? {
          isValid: !!tokenData.is_valid,
          issuedAt: tokenData.issued_at ? new Date(Number(tokenData.issued_at) * 1000).toISOString() : null,
          expiresAt: tokenData.expires_at ? new Date(Number(tokenData.expires_at) * 1000).toISOString() : null,
          scopes,
          missingScopes,
        }
      : null,
    errors: {
      subscribedApps: subsRes.status === "rejected" ? normalizeMetaError(subsRes.reason) : null,
      phone: phoneRes.status === "rejected" ? normalizeMetaError(phoneRes.reason) : null,
      wabaPhones: wabaPhonesRes.status === "rejected" ? normalizeMetaError(wabaPhonesRes.reason) : null,
      debugToken: debugTokenRes.status === "rejected" ? normalizeMetaError(debugTokenRes.reason) : null,
    },
  });
}

module.exports = { metaSubscriptionHealth };

