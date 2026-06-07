const axios = require("axios");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { getMetaAppConfig } = require("@core/config/metaAppConfig");
const {
  cacheWhatsAppBusinessProfile,
  normalizeBusinessProfile,
} = require("@shared/services/whatsappConnectionMetadataService");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

function cleanPayload(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

async function fetchBusinessProfile({ accessToken, phoneNumberId, graphApiVersion }) {
  const client = axios.create({ baseURL: graphBaseUrl(graphApiVersion), timeout: 20000 });
  const res = await client.get(`/${phoneNumberId}/whatsapp_business_profile`, {
    params: { fields: "about,address,description,email,profile_picture_url,websites,vertical" },
    headers: authHeaders(accessToken),
  });
  const data = res.data?.data;
  return Array.isArray(data) ? data[0] : data || null;
}

async function updateBusinessProfile(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 20000 });

  const payload = cleanPayload({
    messaging_product: "whatsapp",
    about: req.body.about,
    address: req.body.address,
    description: req.body.description,
    email: req.body.email,
    websites: req.body.websites,
    vertical: req.body.vertical,
    ...(req.body.profilePictureHandle ? { profile_picture_handle: req.body.profilePictureHandle } : {}),
  });

  try {
    await client.post(`/${creds.phoneNumberId}/whatsapp_business_profile`, payload, {
      headers: { ...authHeaders(creds.accessToken), "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta profile update failed";
    throw new HttpError(400, "Meta profile update failed", { providerError: msg, raw: err?.response?.data || null });
  }

  let profile = null;
  try {
    profile = await fetchBusinessProfile({
      accessToken: creds.accessToken,
      phoneNumberId: creds.phoneNumberId,
      graphApiVersion: creds.graphApiVersion,
    });
  } catch {
    // Best-effort; update already succeeded.
  }
  const profileForCache = profile || {
    about: payload.about,
    address: payload.address,
    description: payload.description,
    email: payload.email,
    websites: payload.websites,
    vertical: payload.vertical,
  };
  await cacheWhatsAppBusinessProfile(req.workspace.id, profileForCache);

  res.json({ success: true, businessProfile: profile || normalizeBusinessProfile(profileForCache) });
}

async function uploadProfilePicture(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const file = req.file;
  if (!file) throw new HttpError(400, "File is required");

  try {
    // WhatsApp business profile picture requires a handle from Meta's Resumable Upload API (not /{phone}/media).
    const { metaAppId: appId } = getMetaAppConfig();

    const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 30000 });

    // Step 1: create upload session
    const sessionRes = await client.post(
      `/${appId}/uploads`,
      null,
      {
        params: { file_length: file.size, file_type: file.mimetype },
        headers: authHeaders(creds.accessToken),
      }
    );
    const sessionId = sessionRes.data?.id ? String(sessionRes.data.id) : null;
    if (!sessionId) throw new Error("No upload session id returned by Meta");

    // Step 2: initiate upload (returns file handle in `h`)
    const uploadRes = await client.post(`/${sessionId}`, file.buffer, {
      headers: {
        Authorization: `OAuth ${creds.accessToken}`,
        Accept: "*/*",
        "Content-Type": file.mimetype,
        file_offset: "0",
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const handle = uploadRes.data?.h ? String(uploadRes.data.h) : null;
    if (!handle) throw new Error("No handle returned by Meta");

    res.json({ success: true, handle });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media upload failed";
    throw new HttpError(400, "Profile picture upload failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

module.exports = { updateBusinessProfile, uploadProfilePicture };

