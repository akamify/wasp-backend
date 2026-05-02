const axios = require("axios");
const { HttpError } = require("../utils/httpError");
const { getCredentialsForUser } = require("../services/credentialsService");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function uploadTemplateMedia(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const file = req.file;
  if (!file) throw new HttpError(400, "File is required");

  try {
    // Template header media example expects a Meta upload handle (same `h` style handle).
    const appId = process.env.APP_ID || process.env.META_APP_ID;
    if (!appId) throw new HttpError(500, "APP_ID is not configured");

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

    // Step 2: upload content (returns handle in `h`)
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
    throw new HttpError(400, "Template media upload failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

module.exports = { uploadTemplateMedia };

