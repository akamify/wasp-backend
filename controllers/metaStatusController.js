const { WhatsAppCredentials } = require("../models/WhatsAppCredentials");
const { decryptString } = require("../utils/crypto");
const axios = require("axios");

function mask(value) {
  const s = String(value || "");
  if (s.length <= 6) return "***";
  return `${s.slice(0, 2)}***${s.slice(-3)}`;
}

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

async function metaStatus(req, res) {
  // This endpoint is dynamic and should not be cached by browsers/proxies.
  res.set("Cache-Control", "no-store");

  const doc = await WhatsAppCredentials.findOne({ workspaceId: req.workspace.id }).select(
    "+accessTokenEnc +phoneNumberIdEnc +businessAccountIdEnc graphApiVersion isValid lastValidatedAt createdAt updatedAt messagingLimitTierCached lastLimitsUpdateAt"
  );

  if (!doc) {
    return res.json({
      success: true,
      status: "disconnected",
      credentials: null,
      build: { commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null },
    });
  }

  const accessToken = decryptString(doc.accessTokenEnc);
  const phoneNumberId = decryptString(doc.phoneNumberIdEnc);
  const businessAccountId = decryptString(doc.businessAccountIdEnc);

  let phone = null;
  let businessProfile = null;
  let debugHint = null;

  try {
    const client = axios.create({ baseURL: graphBaseUrl(doc.graphApiVersion), timeout: 15000 });
    const headers = { Authorization: `Bearer ${accessToken}` };

    const [phoneRes, profileRes] = await Promise.allSettled([
      client.get(`/${phoneNumberId}`, {
        params: {
          fields:
            // NOTE: phone number object does not reliably expose tier/limit fields for all accounts.
            // Keep this list to known-stable fields to avoid (#100) nonexisting field errors.
            "id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,platform_type,throughput,status,account_mode,health_status",
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

    if (phoneRes.status === "fulfilled") phone = phoneRes.value.data;
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
    limits: {
      messagingLimitTier: doc.messagingLimitTierCached || null,
      lastLimitsUpdateAt: doc.lastLimitsUpdateAt || null,
      source: doc.messagingLimitTierCached ? "webhook" : null,
    },
    debugHint,
    build: { commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || null },
  });
}

module.exports = { metaStatus };
