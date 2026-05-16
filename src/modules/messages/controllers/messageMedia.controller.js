const axios = require("axios");
const FormData = require("form-data");
const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");

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
    const safeName = `${crypto.randomUUID()}${file.mimetype === "application/pdf" ? ".pdf" : ""}`;
    form.append("file", file.buffer, { filename: safeName, contentType: file.mimetype });

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

async function downloadMessageMedia(req, res) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const mediaId = String(req.params.id || "").trim();
  if (!mediaId) throw new HttpError(400, "Media id is required");

  const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 30000 });
  const headers = { Authorization: `Bearer ${creds.accessToken}` };

  try {
    const metaRes = await client.get(`/${encodeURIComponent(mediaId)}`, {
      params: { fields: "url,mime_type,file_size,sha256" },
      headers,
    });

    const url = metaRes.data?.url ? String(metaRes.data.url) : "";
    const mimeType = metaRes.data?.mime_type ? String(metaRes.data.mime_type) : "application/octet-stream";
    if (!url) throw new Error("Meta media lookup returned no url");

    const blobRes = await axios.get(url, { responseType: "arraybuffer", headers });
    res.set("Content-Type", mimeType);
    res.set("Cache-Control", "private, max-age=3600");
    res.send(Buffer.from(blobRes.data));
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media download failed";
    throw new HttpError(400, "Message media download failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

module.exports = { uploadMessageMedia, downloadMessageMedia };

