const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { HttpError } = require("@shared/utils/httpError");
const { getCredentialsForUser } = require("@shared/services/credentialsService");
const { TemplateMedia } = require("@infra/database/TemplateMedia");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function storeMediaWithFallback({ workspaceId, handle, originalName, mimeType, size, buffer }) {
  const mongoLimitBytes = 15 * 1024 * 1024;
  const canUseMongo = size > 0 && size <= mongoLimitBytes;

  if (canUseMongo) {
    try {
      await TemplateMedia.updateOne(
        { workspaceId, handle },
        {
          $set: {
            workspaceId,
            handle,
            originalName,
            mimeType,
            size,
            storageType: "mongo",
            filePath: "",
            data: buffer,
          },
        },
        { upsert: true }
      );
      return;
    } catch (_) {}
  }

  const mediaDir = process.env.TEMPLATE_MEDIA_LOCAL_DIR
    ? path.resolve(process.env.TEMPLATE_MEDIA_LOCAL_DIR)
    : path.resolve(process.cwd(), "tmp", "template-media");
  await fs.promises.mkdir(mediaDir, { recursive: true });
  const safeName = Buffer.from(handle).toString("base64url");
  const extFromMime = mimeType.includes("/") ? `.${mimeType.split("/")[1].split(";")[0]}` : "";
  const filePath = path.join(mediaDir, `${safeName}${extFromMime}`);
  await fs.promises.writeFile(filePath, buffer);

  await TemplateMedia.updateOne(
    { workspaceId, handle },
    {
      $set: {
        workspaceId,
        handle,
        originalName,
        mimeType,
        size,
        storageType: "file",
        filePath,
      },
      $unset: { data: 1 },
    },
    { upsert: true }
  );
}

async function uploadTemplateMedia(req) {
  const creds = await getCredentialsForUser(req.workspace.id);
  const file = req.file;
  if (!file) throw new HttpError(400, "File is required");

  try {
    const appId = process.env.APP_ID || process.env.META_APP_ID;
    if (!appId) throw new HttpError(500, "APP_ID is not configured");

    const client = axios.create({ baseURL: graphBaseUrl(creds.graphApiVersion), timeout: 30000 });

    const sessionRes = await client.post(`/${appId}/uploads`, null, {
      params: { file_length: file.size, file_type: file.mimetype },
      headers: authHeaders(creds.accessToken),
    });

    const sessionId = sessionRes.data?.id ? String(sessionRes.data.id) : null;
    if (!sessionId) throw new Error("No upload session id returned by Meta");

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

    const mimeType = String(file.mimetype || "");
    const size = Number(file.size || 0);
    const originalName = String(file.originalname || "file");

    try {
      await storeMediaWithFallback({ workspaceId: req.workspace.id, handle, originalName, mimeType, size, buffer: file.buffer });
    } catch (_) {}

    let previewDataUrl = null;
    if (mimeType.startsWith("image/") && size > 0 && size <= 1024 * 1024) {
      previewDataUrl = `data:${mimeType};base64,${file.buffer.toString("base64")}`;
    }

    return { success: true, handle, previewDataUrl, file: { originalName, mimeType, size } };
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media upload failed";
    throw new HttpError(400, "Template media upload failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

async function downloadTemplateMediaByHandle(req) {
  const handle = String(req.params.handle || "").trim();
  if (!handle) throw new HttpError(400, "Invalid handle");

  const item = await TemplateMedia.findOne({ workspaceId: req.workspace.id, handle });
  if (!item) throw new HttpError(404, "Media not found for this handle");

  const mimeType = String(item.mimeType || "application/octet-stream");
  const filename = String(item.originalName || "file");

  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": mimeType,
    "Content-Disposition": `inline; filename="${filename.replace(/\"/g, "")}"`,
  };

  if (item.storageType === "file" && item.filePath) {
    const exists = fs.existsSync(item.filePath);
    if (!exists) throw new HttpError(404, "Media file no longer available");
    const fileBuffer = await fs.promises.readFile(item.filePath);
    return { headers, buffer: fileBuffer };
  }

  if (!item.data || !item.data.length) {
    throw new HttpError(404, "Media payload not available");
  }

  return { headers, buffer: item.data };
}

module.exports = { uploadTemplateMedia, downloadTemplateMediaByHandle };


