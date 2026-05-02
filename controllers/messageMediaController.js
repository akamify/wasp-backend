const axios = require("axios");
const FormData = require("form-data");
const { HttpError } = require("../utils/httpError");
const { getCredentialsForUser } = require("../services/credentialsService");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

async function uploadMessageMedia(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const file = req.file;
  if (!file) throw new HttpError(400, "File is required");

  try {
    const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 30000 });

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", file.buffer, { filename: file.originalname || "file", contentType: file.mimetype });

    const uploadRes = await client.post(`/${creds.phoneNumberId}/media`, form, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        ...form.getHeaders(),
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const mediaId = uploadRes.data?.id ? String(uploadRes.data.id) : null;
    if (!mediaId) throw new Error("No media id returned by Meta");

    res.json({ success: true, mediaId });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media upload failed";
    throw new HttpError(400, "Message media upload failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

module.exports = { uploadMessageMedia };

