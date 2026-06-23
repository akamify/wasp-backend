const { WhatsAppCredentials } = require("@infra/database/WhatsAppCredentials");
const { Message } = require("@infra/database/Message");
const { decryptString } = require("@shared/utils/crypto");
const { isMetaAuthorizationWarning } = require("@shared/services/whatsappConnectionMetadataService");
const axios = require("axios");

function parseTierLimitToNumber(tier) {
  const s = String(tier || "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("UNLIMITED")) return -1;

  // Support formats like: TIER_250, TIER_2K, TIER_10K, TIER_100K
  const match = s.match(/TIER[_\s-]*([0-9]+)\s*(K|M)?/);
  if (!match) return null;
  let n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const suffix = match[2] || "";
  if (suffix === "K") n *= 1000;
  if (suffix === "M") n *= 1000 * 1000;
  return n;
}

function mask(value) {
  const s = String(value || "");
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function storedPhone(doc, phoneNumberId) {
  return {
    id: phoneNumberId || null,
    display_phone_number: doc.displayPhoneNumber || null,
    verified_name: doc.verifiedName || null,
    quality_rating: doc.qualityRating || null,
    code_verification_status: doc.codeVerificationStatus || null,
    name_status: doc.nameStatus || null,
    platform_type: doc.platformType || null,
    throughput: doc.throughput ?? null,
    account_mode: doc.accountMode || null,
  };
}

function storedBusinessProfile(doc) {
  const profile = doc.businessProfile;
  if (!profile) return null;
  return {
    about: profile.about || null,
    address: profile.address || null,
    description: profile.description || null,
    email: profile.email || null,
    profile_picture_url: profile.profilePictureUrl || null,
    websites: Array.isArray(profile.websites) ? profile.websites : [],
    vertical: profile.vertical || null,
  };
}

async function metaStatus(req, res) {
  // This endpoint is dynamic and should not be cached by browsers/proxies.
  res.set("Cache-Control", "no-store");

  const doc = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id, isActive: { $ne: false } }).select(
    "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc graphApiVersion isValid lastValidatedAt createdAt updatedAt messagingLimitTierCached messagingLimitCurrentCached messagingLimitNextCached lastLimitsUpdateAt displayPhoneNumber verifiedName qualityRating codeVerificationStatus nameStatus platformType throughput accountMode businessProfile metadataWarnings lastSuccessfulSendAt lastStatusWebhookAt"
  );

  if (!doc) {
    return res.json({
      success: true,
      status: "disconnected",
      credentials: null,
      cloudApiActive: false,
      canSendServiceMessages: false,
      businessVerificationPending: false,
      paymentSetupRequiredForTemplates: false,
      lastSuccessfulSendAt: null,
      lastStatusWebhookAt: null,
      setupWarnings: [],
      blockingIssues: ["WhatsApp phone number is not connected."],
      build: { commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null },
    });
  }

  const accessToken = decryptString(doc.accessTokenEnc);
  const phoneNumberId = decryptString(doc.phoneNumberIdEnc);
  const businessAccountId = decryptString(doc.businessAccountIdEnc);

  let phone = storedPhone(doc, phoneNumberId);
  let businessProfile = storedBusinessProfile(doc);
  let debugHint = null;
  let apiTier = null;

  try {
    const client = axios.create({ baseURL: graphBaseUrl(doc.graphApiVersion), timeout: 15000 });
    const headers = { Authorization: `Bearer ${accessToken}` };

    const [phoneRes, profileRes] = await Promise.allSettled([
      client.get(`/${phoneNumberId}`, {
        params: {
          fields:
            // NOTE: phone number object does not reliably expose tier/limit fields for all accounts.
            // Keep this list to known-stable fields to avoid (#100) nonexisting field errors.
            "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,throughput,status,account_mode,health_status,whatsapp_business_manager_messaging_limit",
        },
        headers,
      }),
      client.get(`/${phoneNumberId}/whatsapp_business_profile`, {
        params: {
          fields: "about,address,description,email,profile_picture_url,websites,vertical",
        },
        headers,
      }),
    ]);

    if (phoneRes.status === "fulfilled") {
      phone = phoneRes.value.data;
      apiTier = phone?.whatsapp_business_manager_messaging_limit || null;
    }
    if (profileRes.status === "fulfilled") {
      const data = profileRes.value.data?.data;
      businessProfile = Array.isArray(data) ? data[0] : data || null;
    }

    if (phoneRes.status === "rejected" || profileRes.status === "rejected") {
      const err = phoneRes.status === "rejected" ? phoneRes.reason : profileRes.reason;
      debugHint =
        err?.response?.data?.error?.message ||
        err?.message ||
        "Unable to fetch WhatsApp Manager profile from Meta";
    }
  } catch (err) {
    debugHint =
      err?.response?.data?.error?.message ||
      err?.message ||
      "Unable to fetch WhatsApp Manager profile from Meta";
  }

  const [latestSuccessfulSend, latestStatusMessage] = await Promise.all([
    Message.findOne({ workspaceId: req.workspace.id, direction: "outbound", status: { $in: ["sent", "delivered", "read"] } })
      .sort({ sentAt: -1, createdAt: -1 })
      .select("sentAt createdAt")
      .lean(),
    Message.findOne({ workspaceId: req.workspace.id, direction: "outbound", status: { $in: ["delivered", "read", "failed"] } })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean(),
  ]);
  const platformType = String(phone?.platform_type || doc.platformType || "").toUpperCase();
  const accountMode = String(phone?.account_mode || doc.accountMode || "").toUpperCase();
  const codeVerificationStatus = String(phone?.code_verification_status || doc.codeVerificationStatus || "").toUpperCase();
  const lastSuccessfulSendAt = doc.lastSuccessfulSendAt || latestSuccessfulSend?.sentAt || latestSuccessfulSend?.createdAt || null;
  const lastStatusWebhookAt = doc.lastStatusWebhookAt || latestStatusMessage?.updatedAt || null;
  const cloudApiActive = Boolean(phoneNumberId) && platformType === "CLOUD_API" && accountMode === "LIVE";
  const operationalEvidence = Boolean(lastSuccessfulSendAt || lastStatusWebhookAt);
  const canSendServiceMessages = cloudApiActive && operationalEvidence;
  const businessVerificationPending =
    String(phone?.account_status || phone?.status || "").toLowerCase() === "pending_verification" ||
    (cloudApiActive && Boolean(codeVerificationStatus) && codeVerificationStatus !== "VERIFIED");
  const paymentSetupRequiredForTemplates = businessVerificationPending;
  const setupWarnings = [];
  const blockingIssues = [];
  if (!phoneNumberId) blockingIssues.push("WhatsApp phone number is not connected.");
  else if (platformType !== "CLOUD_API") blockingIssues.push("Cloud API is not registered for this phone number.");
  else if (accountMode !== "LIVE") blockingIssues.push("WhatsApp account mode is not LIVE.");
  if (businessVerificationPending) {
    setupWarnings.push("Business verification is pending. Service-window replies can work, but business-initiated/template messaging and higher limits may require payment/business verification.");
  }
  if (codeVerificationStatus === "EXPIRED" && cloudApiActive && operationalEvidence) {
    setupWarnings.push("Code verification metadata is expired; the operational Cloud API connection remains active.");
  }

  return res.json({
    success: true,
    status: doc.isValid ? "active" : "pending",
    credentials: {
      id: String(doc._id),
      phoneNumberId: mask(phoneNumberId),
      businessAccountId: mask(businessAccountId),
      graphApiVersion: doc.graphApiVersion,
      isValid: doc.isValid,
      lastValidatedAt: doc.lastValidatedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
    phone,
    businessProfile,
    cloudApiActive,
    canSendServiceMessages,
    businessVerificationPending,
    paymentSetupRequiredForTemplates,
    lastSuccessfulSendAt,
    lastStatusWebhookAt,
    setupWarnings,
    blockingIssues,
    limits: {
      messagingLimitTier: doc.messagingLimitTierCached || apiTier || null,
      messagingLimitCurrent: Number.isFinite(doc.messagingLimitCurrentCached)
        ? doc.messagingLimitCurrentCached
        : parseTierLimitToNumber(doc.messagingLimitTierCached || apiTier),
      messagingLimitNext: Number.isFinite(doc.messagingLimitNextCached) ? doc.messagingLimitNextCached : null,
      lastLimitsUpdateAt: doc.lastLimitsUpdateAt || null,
      source: doc.messagingLimitTierCached || doc.messagingLimitCurrentCached ? "webhook" : apiTier ? "api" : null,
    },
    debugHint,
    authorizationRequired:
      isMetaAuthorizationWarning(debugHint) ||
      (Array.isArray(doc.metadataWarnings) && doc.metadataWarnings.some(isMetaAuthorizationWarning)),
    build: { commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null },
  });
}

module.exports = { metaStatus };
