const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { hashForLookup } = require("@shared/utils/hash");
const { decryptString, encryptString } = require("@shared/utils/crypto");
const { encryptSecret } = require("@shared/utils/secretCrypto");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const { markTemplatesStaleForInactiveWabas, stampUntaggedTemplatesForWaba } = require("@shared/services/templateOwnershipService");
const {
  refreshWhatsAppConnectionMetadata,
  serializeWhatsAppConnection,
} = require("@shared/services/whatsappConnectionMetadataService");
const { isEmbeddedSignupConnection } = require("@shared/services/whatsappConnectionService");
const templatesService = require("@modules/templates/services/templates.service");
const { logWorkspaceActivity } = require("@modules/workspaces/services/workspaceActivity.service");
const { Workspace } = require("@infra/database/Workspace");

function graphBaseUrl() {
  const version = process.env.META_GRAPH_VERSION || "v25.0";
  return `https://graph.facebook.com/${version}`;
}

function sanitizeMetaError(err, fallback) {
  return (
    err?.response?.data?.error?.error_user_msg ||
    err?.response?.data?.error?.message ||
    err?.message ||
    fallback
  );
}

function mask(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function maskId(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 10) return `${s.slice(0, 2)}***${s.slice(-2)}`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function maskPhone(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.length <= 6) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function sanitizeScope(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 100);
}

function buildTokenDebugSummary(tokenDebugData) {
  if (!tokenDebugData) return null;
  const granularScopes = Array.isArray(tokenDebugData.granular_scopes)
    ? tokenDebugData.granular_scopes.map((scope) => ({
        scope: sanitizeScope(scope?.scope),
        target_ids: Array.isArray(scope?.target_ids) ? scope.target_ids.map((targetId) => maskId(targetId)) : [],
      }))
    : [];
  return {
    appId: tokenDebugData.app_id ? maskId(tokenDebugData.app_id) : null,
    type: tokenDebugData.type || null,
    application: tokenDebugData.application || null,
    userId: tokenDebugData.user_id || null,
    isValid: Boolean(tokenDebugData.is_valid),
    expiresAt: tokenDebugData.expires_at ? new Date(Number(tokenDebugData.expires_at) * 1000).toISOString() : null,
    issuedAt: tokenDebugData.issued_at ? new Date(Number(tokenDebugData.issued_at) * 1000).toISOString() : null,
    scopes: Array.isArray(tokenDebugData.scopes) ? tokenDebugData.scopes.map(sanitizeScope).filter(Boolean) : [],
    granularScopes,
  };
}

async function debugAccessToken({ client, token, appId, appSecret }) {
  const response = await client.get("/debug_token", {
    params: {
      input_token: token,
      access_token: `${appId}|${appSecret}`,
    },
  });
  return response?.data?.data || null;
}

function logGraphCall({ operation, path, wabaId, phoneNumberId }) {
  if (String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() !== "true") return;
  // eslint-disable-next-line no-console
  console.info("[embedded-signup] graph call", {
    operation,
    path,
    wabaId: maskId(wabaId),
    phoneNumberId: maskId(phoneNumberId),
  });
}

async function exchangeEmbeddedSignupCode(req, res) {
  const workspaceId = String(req.workspace.id);
  const code = String(req.body?.code || "").trim();
  const wabaId = String(req.body?.waba_id || "").trim();
  const phoneNumberId = String(req.body?.phone_number_id || "").trim();
  const missing = {
    code: !code,
    waba_id: !wabaId,
  };
  if (missing.code || missing.waba_id) {
    return res.status(400).json({
      success: false,
      message: "Embedded signup details missing. Please complete signup popup flow.",
      missing,
    });
  }

  const debug = String(process.env.META_WEBHOOK_DEBUG || "").toLowerCase() === "true";
  if (debug) {
    // eslint-disable-next-line no-console
    console.info("[embedded-signup] exchange request", {
      workspaceIdPresent: !!workspaceId,
      wabaId: maskId(wabaId),
      phoneNumberId: maskId(phoneNumberId),
      hasCode: !!code,
      hasWabaId: !!wabaId,
      hasPhoneNumberId: !!phoneNumberId,
    });
  }

  let appId = "";
  let appSecret = "";
  try {
    const cfg = getMetaAppConfig();
    appId = cfg.metaAppId;
    appSecret = cfg.metaAppSecret;
  } catch {
    throw new HttpError(500, "Meta app is not configured");
  }

  const baseURL = graphBaseUrl();
  let businessToken = "";
  try {
    logGraphCall({
      operation: "exchange_code",
      path: "/oauth/access_token",
      wabaId,
      phoneNumberId,
    });
    const tokenRes = await axios.get(`${baseURL}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code },
      timeout: 20000,
    });
    businessToken = String(tokenRes?.data?.access_token || "").trim();
    if (!businessToken) throw new Error("access_token missing");
    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] code exchange success", { hasToken: !!businessToken });
    }
  } catch (err) {
    if (debug) {
      // eslint-disable-next-line no-console
      console.warn("[embedded-signup] code exchange failed", { reason: sanitizeMetaError(err, "Meta code exchange failed") });
    }
    throw new HttpError(400, "Could not exchange Meta code", {
      message: sanitizeMetaError(err, "Meta code exchange failed"),
    });
  }

  const client = axios.create({ baseURL, timeout: 20000 });
  let debugTokenData = null;
  try {
    logGraphCall({
      operation: "debug_business_token",
      path: "/debug_token",
      wabaId,
      phoneNumberId,
    });
    debugTokenData = await debugAccessToken({
      client,
      token: businessToken,
      appId,
      appSecret,
    });
  } catch (err) {
    throw new HttpError(400, "Could not validate the Meta business token", {
      message: sanitizeMetaError(err, "Meta business token debug failed"),
    });
  }

  const scopes = Array.isArray(debugTokenData?.scopes) ? debugTokenData.scopes.map(sanitizeScope).filter(Boolean) : [];
  const granularScopes = Array.isArray(debugTokenData?.granular_scopes) ? debugTokenData.granular_scopes : [];
  const granularScopeNames = granularScopes.map((scope) => sanitizeScope(scope?.scope)).filter(Boolean);
  const grantedScopes = [...new Set([...scopes, ...granularScopeNames])];
  const targetIds = [
    ...new Set(
      granularScopes.flatMap((scope) =>
        Array.isArray(scope?.target_ids) ? scope.target_ids.map((targetId) => String(targetId).trim()).filter(Boolean) : []
      )
    ),
  ];
  const targetIncludesWaba = targetIds.includes(wabaId);
  // eslint-disable-next-line no-console
  console.info("[embedded-signup] debug_token", {
    scopes,
    grantedScopes,
    granularScopes: granularScopes.map((scope) => ({
      scope: sanitizeScope(scope?.scope),
      target_ids: Array.isArray(scope?.target_ids) ? scope.target_ids.map(maskId) : [],
    })),
    targetIds: targetIds.map(maskId),
    targetIncludesRequestedWaba: targetIncludesWaba,
  });
  if (debugTokenData?.is_valid !== true) {
    throw new HttpError(400, "Meta returned an invalid business token. Please reconnect WhatsApp.");
  }
  if (String(debugTokenData?.app_id || "").trim() !== appId) {
    throw new HttpError(
      400,
      "Meta returned a token for a different app. Verify the Embedded Signup configuration ID and reconnect WhatsApp."
    );
  }
  const customerHeaders = { Authorization: `Bearer ${businessToken}` };
  let validatedPhoneNumber = null;

  try {
    logGraphCall({
      operation: "list_waba_phone_numbers",
      path: `/${wabaId}/phone_numbers?fields=id,display_phone_number`,
      wabaId,
      phoneNumberId,
    });
    const phoneListRes = await client.get(`/${wabaId}/phone_numbers`, {
      headers: customerHeaders,
      params: { fields: "id,display_phone_number" },
    });
    const phoneRows = Array.isArray(phoneListRes?.data?.data) ? phoneListRes.data.data : [];

    if (!phoneNumberId) {
      return res.json({
        success: false,
        needsPhoneSelection: true,
        message: "Meta did not return a phone number. Please select a phone number and reconnect WhatsApp.",
        phones: phoneRows.map((item) => ({
          id: String(item?.id || "").trim(),
          display_phone_number: String(item?.display_phone_number || "").trim() || null,
        })),
      });
    }

    validatedPhoneNumber = phoneRows.find((item) => String(item?.id || "").trim() === phoneNumberId) || null;
    if (!validatedPhoneNumber) {
      throw new HttpError(400, "Selected phone number could not be matched to the selected WABA. Please reconnect WhatsApp and select the correct phone number.");
    }

    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] phone_numbers fetched", {
        count: phoneRows.length,
        returned: phoneRows.map((item) => ({
          id: maskId(item?.id),
          display_phone_number: maskPhone(item?.display_phone_number),
        })),
        matchedProvided: true,
      });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(
      400,
      "Meta authorized the login but did not allow access to the selected WABA. Verify the app-role invitation is accepted and the Embedded Signup configuration includes WhatsApp Business Management.",
      {
        message: sanitizeMetaError(err, "WABA phone read failed"),
        grantedScopes,
      }
    );
  }

  let subscribed = false;
  try {
    logGraphCall({
      operation: "subscribe_waba_webhook",
      path: `/${wabaId}/subscribed_apps`,
      wabaId,
      phoneNumberId: String(validatedPhoneNumber?.id || phoneNumberId),
    });
    const subscribeRes = await client.post(`/${wabaId}/subscribed_apps`, null, { headers: customerHeaders });
    subscribed = Boolean(subscribeRes?.data?.success);
    if (debug) {
      // eslint-disable-next-line no-console
      console.info("[embedded-signup] subscribed_apps result", { subscribed });
    }
  } catch (err) {
    throw new HttpError(400, "Could not subscribe WABA to webhook", {
      message: sanitizeMetaError(err, "WABA webhook subscription failed"),
    });
  }
  if (!subscribed) {
    throw new HttpError(400, "Could not subscribe WABA to webhook");
  }

  const now = new Date();
  const existingCredentials = await WhatsAppCredentials.findOne({ workspaceId, isActive: { $ne: false } }).select(
    "+businessAccountIdEnc businessAccountIdPlain"
  );
  const previousWabaId = String(
    existingCredentials?.businessAccountIdPlain ||
      (existingCredentials?.businessAccountIdEnc ? decryptString(existingCredentials.businessAccountIdEnc) : "")
  ).trim();
  await stampUntaggedTemplatesForWaba({ workspaceId, wabaId: previousWabaId });
  await WhatsAppCredentials.updateMany(
    { workspaceId, isActive: { $ne: false } },
    { $set: { isActive: false, status: "disconnected", disconnectedAt: now } }
  );
  await markTemplatesStaleForInactiveWabas({ workspaceId, activeWabaId: wabaId });
  await WhatsAppCredentials.create({
    workspaceId,
    accessTokenEnc: encryptString(businessToken),
    businessTokenEnc: encryptSecret(businessToken),
    phoneNumberIdEnc: encryptString(String(validatedPhoneNumber.id)),
    businessAccountIdEnc: encryptString(wabaId),
    phoneNumberIdHash: hashForLookup(String(validatedPhoneNumber.id)),
    businessAccountIdHash: hashForLookup(wabaId),
    phoneNumberIdPlain: String(validatedPhoneNumber.id),
    businessAccountIdPlain: wabaId,
    phoneNumberId: String(validatedPhoneNumber.id),
    wabaId,
    connectionMode: "customer_embedded_signup",
    tokenType: "embedded_signup_customer_token",
    tokenDebugSummary: buildTokenDebugSummary(debugTokenData),
    displayPhoneNumber: String(validatedPhoneNumber?.display_phone_number || "").trim() || null,
    graphApiVersion: process.env.META_GRAPH_VERSION || "v25.0",
    isValid: true,
    isActive: true,
    status: "active",
    webhookSubscribed: subscribed,
    connectionMethod: "embedded_signup",
    lastError: null,
    lastValidatedAt: now,
    connectedAt: now,
    disconnectedAt: null,
    lastEditedAt: now,
    lastEditedBy: req.user?.id || null,
  });
  await refreshWhatsAppConnectionMetadata(workspaceId).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[whatsapp-metadata] metadata refresh after reconnect failed", {
      workspaceId,
      maskedWabaId: maskId(wabaId),
      maskedPhoneNumberId: maskId(validatedPhoneNumber.id),
      reason: sanitizeMetaError(err, "Metadata refresh failed"),
    });
  });
  await logWorkspaceActivity({
    workspaceId,
    actorUserId: req.user?.id || null,
    action: "whatsapp.connected",
    entityType: "whatsapp_connection",
    entityId: wabaId,
    metadata: { maskedWabaId: maskId(wabaId), maskedPhoneNumberId: maskId(validatedPhoneNumber.id) },
  });
  await templatesService.syncMetaTemplates({ workspace: req.workspace, body: {} }).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn("[templates] refresh after reconnect failed", {
      workspaceId,
      maskedWabaId: maskId(wabaId),
      reason: sanitizeMetaError(err, "Template refresh failed"),
    });
  });

  if (debug) {
    // eslint-disable-next-line no-console
    console.info("[embedded-signup] connection active", {
      hasWabaId: !!wabaId,
      hasPhoneNumberId: !!phoneNumberId,
      webhookSubscribed: subscribed,
    });
  }
  return res.json({
    success: true,
    connected: true,
    status: "active",
    waba_id_masked: mask(wabaId),
    phone_number_id_masked: mask(String(validatedPhoneNumber.id)),
    display_phone_number: String(validatedPhoneNumber?.display_phone_number || "").trim() || null,
    webhook_subscribed: subscribed,
  });
}

async function getWhatsAppConnection(req, res) {
  const row = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id, isActive: { $ne: false } }).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary"
  );
  if (!row) {
    return res.json(serializeWhatsAppConnection(null));
  }
  return res.json(serializeWhatsAppConnection(row));
}

async function disconnectWhatsAppConnection(req, res) {
  const row = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id, isActive: { $ne: false } }).select(
    "+accessTokenEnc +businessAccountIdEnc status"
  );
  if (!row) return res.json({ success: true, status: "disconnected" });

  try {
    const token = row.accessTokenEnc ? require("@shared/utils/crypto").decryptString(row.accessTokenEnc) : "";
    const wabaId = row.businessAccountIdEnc ? decryptString(row.businessAccountIdEnc) : "";
    await stampUntaggedTemplatesForWaba({ workspaceId: req.workspace.id, wabaId });
    if (token && wabaId) {
      const baseURL = graphBaseUrl();
      await axios.delete(`${baseURL}/${wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12000,
      }).catch(() => null);
    }
  } catch {}

  await WhatsAppCredentials.updateOne(
    { _id: row._id },
    { $set: { isActive: false, isValid: false, status: "disconnected", disconnectedAt: new Date() } }
  );
  await markTemplatesStaleForInactiveWabas({ workspaceId: req.workspace.id, activeWabaId: "" });
  await logWorkspaceActivity({
    workspaceId: req.workspace.id,
    actorUserId: req.user?.id || null,
    action: "whatsapp.disconnected",
    entityType: "whatsapp_connection",
  });
  return res.json({ success: true, status: "disconnected" });
}

async function forceEmbeddedActiveConnection(req, res) {
  const workspace = await Workspace.findById(req.workspace.id).select("ownerId ownerUserId");
  const isOwner = String(workspace?.ownerUserId || workspace?.ownerId || "") === String(req.user?.id || "");
  const isSuperAdmin = String(req.user?.role || "") === "super_admin";
  if (!workspace) throw new HttpError(404, "Workspace not found");
  if (!isOwner && !isSuperAdmin) {
    throw new HttpError(403, "Owner or super admin access required");
  }

  const rows = await WhatsAppCredentials.find({ workspaceId: req.workspace.id, isActive: { $ne: false } })
    .sort({ connectedAt: -1, updatedAt: -1 })
    .select(
      "_id wabaId phoneNumberId displayPhoneNumber wabaName connectionMode tokenType tokenDebugSummary connectedAt updatedAt status isActive"
    );
  const embedded = rows.find(isEmbeddedSignupConnection) || null;
  if (!embedded) {
    throw new HttpError(404, "No Embedded Signup connection found for this workspace.");
  }

  const now = new Date();
  const deactivated = await WhatsAppCredentials.updateMany(
    { workspaceId: req.workspace.id, isActive: { $ne: false }, _id: { $ne: embedded._id } },
    { $set: { isActive: false, status: "disconnected", disconnectedAt: now } }
  );
  await WhatsAppCredentials.updateOne(
    { _id: embedded._id },
    {
      $set: {
        isActive: true,
        status: "active",
        disconnectedAt: null,
      },
    }
  );

  // eslint-disable-next-line no-console
  console.info("[whatsapp-connection] old manual connection deactivated", {
    workspaceId: String(req.workspace.id),
    maskedWabaId: maskId(embedded.wabaId),
    deactivatedCount: Number(deactivated?.modifiedCount || 0),
  });

  await markTemplatesStaleForInactiveWabas({ workspaceId: req.workspace.id, activeWabaId: embedded.wabaId });
  await refreshWhatsAppConnectionMetadata(req.workspace.id).catch(() => null);
  await templatesService.syncMetaTemplates({ workspace: req.workspace, body: {} }).catch(() => null);

  const latest = await WhatsAppCredentials.findById(embedded._id).select(
    "status webhookSubscribed connectedAt lastError displayPhoneNumber phoneNumberId phoneNumberIdPlain wabaId businessAccountIdPlain wabaName verifiedName nameStatus qualityRating codeVerificationStatus platformType accountMode throughput messagingLimitTier messagingLimitTierCached businessProfile lastMetadataSyncAt metadataFetchStatus metadataWarnings isValid isActive connectionMode tokenType tokenDebugSummary"
  );
  return res.json({
    success: true,
    connection: serializeWhatsAppConnection(latest),
  });
}

module.exports = {
  exchangeEmbeddedSignupCode,
  getWhatsAppConnection,
  disconnectWhatsAppConnection,
  forceEmbeddedActiveConnection,
};
