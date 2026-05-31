const axios = require("axios");
const { resolveActiveConnection, maskId } = require("@shared/services/whatsappConnectionService");

const WABA_FIELDS = "id,name,currency,timezone_id,message_template_namespace";
const PHONE_FIELDS =
  "id,display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type,account_mode,throughput,messaging_limit_tier";
const MINIMAL_PHONE_FIELDS = "id,display_phone_number";
const PROFILE_FIELDS = "about,address,description,email,profile_picture_url,websites,vertical";

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function warningFor(stage, err) {
  const message = String(
    err?.response?.data?.error?.error_user_msg ||
      err?.response?.data?.error?.message ||
      err?.message ||
      "Meta metadata request failed"
  )
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return `${stage}: ${message}`;
}

function normalizePhone(phone) {
  if (!phone) return {};
  return {
    displayPhoneNumber: phone.display_phone_number || null,
    verifiedName: phone.verified_name || null,
    nameStatus: phone.name_status || null,
    qualityRating: phone.quality_rating || null,
    codeVerificationStatus: phone.code_verification_status || null,
    platformType: phone.platform_type || null,
    accountMode: phone.account_mode || null,
    throughput: phone.throughput ?? null,
    messagingLimitTier: phone.messaging_limit_tier || null,
  };
}

function normalizeBusinessProfile(profile) {
  return {
    about: profile?.about || null,
    address: profile?.address || null,
    description: profile?.description || null,
    email: profile?.email || null,
    profilePictureUrl: profile?.profile_picture_url || null,
    websites: Array.isArray(profile?.websites) ? profile.websites.map(String) : [],
    vertical: profile?.vertical || null,
  };
}

function computeConnectionStatus(connection) {
  if (!connection) return "error";
  const metadataFetchStatus = String(connection.metadataFetchStatus || "pending").toLowerCase();
  const codeVerificationStatus = String(connection.codeVerificationStatus || "").toUpperCase();
  const nameStatus = String(connection.nameStatus || "").toUpperCase();
  if (codeVerificationStatus && codeVerificationStatus !== "VERIFIED") return "pending_verification";
  if (["PENDING", "IN_REVIEW"].includes(nameStatus)) return "pending_display_name_review";
  if (metadataFetchStatus === "error") return "error";
  if (metadataFetchStatus !== "complete") return "metadata_partial";
  if (connection.phoneNumberId || connection.phoneNumberIdPlain) return "connected";
  return "metadata_partial";
}

function serializeWhatsAppConnection(doc) {
  if (!doc) {
    return {
      connected: false,
      status: "disconnected",
      connectionStatus: "error",
      metadataFetchStatus: "pending",
      metadataWarnings: [],
    };
  }
  const wabaId = String(doc.wabaId || doc.businessAccountIdPlain || "").trim();
  const phoneNumberId = String(doc.phoneNumberId || doc.phoneNumberIdPlain || "").trim();
  return {
    connected: Boolean(doc.isActive && doc.isValid),
    status: doc.status || (doc.isValid ? "active" : "pending"),
    connectionStatus: computeConnectionStatus(doc),
    wabaName: doc.wabaName || null,
    maskedWabaId: maskId(wabaId) || null,
    displayPhoneNumber: doc.displayPhoneNumber || null,
    maskedPhoneNumberId: maskId(phoneNumberId) || null,
    verifiedName: doc.verifiedName || null,
    nameStatus: doc.nameStatus || null,
    qualityRating: doc.qualityRating || null,
    codeVerificationStatus: doc.codeVerificationStatus || null,
    platformType: doc.platformType || null,
    accountMode: doc.accountMode || null,
    messagingLimitTier: doc.messagingLimitTier || doc.messagingLimitTierCached || null,
    throughput: doc.throughput ?? null,
    businessProfile: doc.businessProfile || null,
    lastMetadataSyncAt: doc.lastMetadataSyncAt || null,
    metadataFetchStatus: doc.metadataFetchStatus || "pending",
    metadataWarnings: Array.isArray(doc.metadataWarnings) ? doc.metadataWarnings : [],
    webhookSubscribed: Boolean(doc.webhookSubscribed),
    connectedAt: doc.connectedAt || null,
    lastError: doc.lastError || null,
    // Preserve the existing frontend response keys during migration.
    waba_name: doc.wabaName || null,
    waba_id_masked: maskId(wabaId) || null,
    display_phone_number: doc.displayPhoneNumber || null,
    phone_number_id_masked: maskId(phoneNumberId) || null,
    webhook_subscribed: Boolean(doc.webhookSubscribed),
    connected_at: doc.connectedAt || null,
    last_error: doc.lastError || null,
  };
}

async function refreshWhatsAppConnectionMetadata(workspaceId) {
  const connection = await resolveActiveConnection(workspaceId, { requireValid: false });
  if (!connection) return null;

  const client = axios.create({
    baseURL: graphBaseUrl(connection.graphApiVersion),
    timeout: 15000,
  });
  const headers = authHeaders(connection.accessToken);
  const warnings = [];
  const patch = { lastMetadataSyncAt: new Date() };
  let phoneFromList = null;
  let successfulStages = 0;

  try {
    const res = await client.get(`/${connection.wabaId}`, { params: { fields: WABA_FIELDS }, headers });
    const waba = res?.data || {};
    patch.wabaName = waba.name || null;
    patch.wabaCurrency = waba.currency || null;
    patch.wabaTimezoneId = waba.timezone_id == null ? null : String(waba.timezone_id);
    patch.messageTemplateNamespace = waba.message_template_namespace || null;
    successfulStages += 1;
    console.info("[whatsapp-metadata] waba metadata fetched", {
      workspaceId: String(workspaceId),
      maskedWabaId: maskId(connection.wabaId),
    });
  } catch (err) {
    warnings.push(warningFor("waba_metadata", err));
  }

  try {
    const res = await client.get(`/${connection.wabaId}/phone_numbers`, { params: { fields: PHONE_FIELDS }, headers });
    const phones = Array.isArray(res?.data?.data) ? res.data.data : [];
    phoneFromList = phones.find((phone) => String(phone?.id || "") === String(connection.phoneNumberId)) || null;
    successfulStages += 1;
    console.info("[whatsapp-metadata] phone list fetched", {
      workspaceId: String(workspaceId),
      maskedWabaId: maskId(connection.wabaId),
      phoneCount: phones.length,
    });
  } catch (err) {
    warnings.push(warningFor("phone_list_extended", err));
    console.warn("[whatsapp-metadata] phone enrichment partial", {
      workspaceId: String(workspaceId),
      maskedWabaId: maskId(connection.wabaId),
      stage: "phone_list_extended",
    });
    try {
      const res = await client.get(`/${connection.wabaId}/phone_numbers`, {
        params: { fields: MINIMAL_PHONE_FIELDS },
        headers,
      });
      const phones = Array.isArray(res?.data?.data) ? res.data.data : [];
      phoneFromList = phones.find((phone) => String(phone?.id || "") === String(connection.phoneNumberId)) || null;
      successfulStages += 1;
      console.info("[whatsapp-metadata] phone list fetched", {
        workspaceId: String(workspaceId),
        maskedWabaId: maskId(connection.wabaId),
        phoneCount: phones.length,
        minimalFields: true,
      });
    } catch (minimalErr) {
      warnings.push(warningFor("phone_list_minimal", minimalErr));
    }
  }

  let directPhone = null;
  try {
    const res = await client.get(`/${connection.phoneNumberId}`, { params: { fields: PHONE_FIELDS }, headers });
    directPhone = res?.data || null;
    successfulStages += 1;
  } catch (err) {
    warnings.push(warningFor("phone_metadata", err));
    console.warn("[whatsapp-metadata] phone enrichment partial", {
      workspaceId: String(workspaceId),
      maskedPhoneNumberId: maskId(connection.phoneNumberId),
      stage: "phone_metadata",
    });
  }
  Object.assign(patch, normalizePhone({ ...(phoneFromList || {}), ...(directPhone || {}) }));

  try {
    const res = await client.get(`/${connection.phoneNumberId}/whatsapp_business_profile`, {
      params: { fields: PROFILE_FIELDS },
      headers,
    });
    const rows = res?.data?.data;
    const profile = Array.isArray(rows) ? rows[0] : rows || null;
    patch.businessProfile = normalizeBusinessProfile(profile);
    successfulStages += 1;
    console.info("[whatsapp-metadata] business profile fetched", {
      workspaceId: String(workspaceId),
      maskedPhoneNumberId: maskId(connection.phoneNumberId),
    });
  } catch (err) {
    warnings.push(warningFor("business_profile", err));
  }

  patch.metadataWarnings = warnings;
  patch.metadataFetchStatus =
    successfulStages === 0
      ? "error"
      : warnings.length || (!phoneFromList && !directPhone)
        ? "partial"
        : "complete";
  await connection.doc.updateOne({ $set: patch });
  Object.assign(connection.doc, patch);
  console.info("[whatsapp-metadata] metadata refresh complete", {
    workspaceId: String(workspaceId),
    maskedWabaId: maskId(connection.wabaId),
    maskedPhoneNumberId: maskId(connection.phoneNumberId),
    metadataFetchStatus: patch.metadataFetchStatus,
    warningCount: warnings.length,
  });
  return connection.doc;
}

module.exports = {
  computeConnectionStatus,
  refreshWhatsAppConnectionMetadata,
  serializeWhatsAppConnection,
};
