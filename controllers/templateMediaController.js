const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { HttpError } = require("../utils/httpError");
const { getCredentialsForUser } = require("../services/credentialsService");
const { TemplateMedia } = require("../models/TemplateMedia");

function graphBaseUrl(graphApiVersion) {
  const version = graphApiVersion || process.env.META_GRAPH_VERSION || "v22.0";
  return `https://graph.facebook.com/${version}`;
}

function authHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}` };
}

async function storeMediaWithFallback({ workspaceId, handle, originalName, mimeType, size, buffer }) {
  // MongoDB document size limit is ~16MB. Keep buffer-storage below that.
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
    } catch (_) {
      // fallback to file storage
    }
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

    const mimeType = String(file.mimetype || "");
    const size = Number(file.size || 0);
    const originalName = String(file.originalname || "file");

    // Persist uploaded bytes locally without requiring cloud bucket.
    // For small files we keep Mongo storage; for larger files fallback to filesystem.
    try {
      await storeMediaWithFallback({
        workspaceId: req.workspace.id,
        handle,
        originalName,
        mimeType,
        size,
        buffer: file.buffer,
      });
    } catch (_) {
      // best-effort: preview storage should never block handle creation
    }

    // Meta upload handles (the `h` value) are not retrievable as files later.
    // For UX in our template preview, we optionally return an inline preview for small images.
    let previewDataUrl = null;
    if (mimeType.startsWith("image/") && size > 0 && size <= 1024 * 1024) {
      previewDataUrl = `data:${mimeType};base64,${file.buffer.toString("base64")}`;
    }

    res.json({
      success: true,
      handle,
      previewDataUrl,
      file: { originalName, mimeType, size },
    });
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err?.message || "Meta media upload failed";
    throw new HttpError(400, "Template media upload failed", { providerError: msg, raw: err?.response?.data || null });
  }
}

async function downloadTemplateMediaByHandle(req, res) {
  const handle = String(req.params.handle || "").trim();
  if (!handle) throw new HttpError(400, "Invalid handle");

  const item = await TemplateMedia.findOne({ workspaceId: req.workspace.id, handle });
  if (!item) throw new HttpError(404, "Media not found for this handle");

  const mimeType = String(item.mimeType || "application/octet-stream");
  const filename = String(item.originalName || "file");

  res.set("Cache-Control", "no-store");
  res.set("Content-Type", mimeType);
  // Inline so images/videos render in preview; browsers still allow download.
  res.set("Content-Disposition", `inline; filename="${filename.replace(/\"/g, "")}"`);

  if (item.storageType === "file" && item.filePath) {
    const exists = fs.existsSync(item.filePath);
    if (!exists) throw new HttpError(404, "Media file no longer available");
    const fileBuffer = await fs.promises.readFile(item.filePath);
    return res.status(200).send(fileBuffer);
  }

  if (!item.data || !item.data.length) {
    throw new HttpError(404, "Media payload not available");
  }

  return res.status(200).send(item.data);
}

module.exports = { uploadTemplateMedia, downloadTemplateMediaByHandle };
