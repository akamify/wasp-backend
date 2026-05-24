const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HttpError } = require("@shared/utils/httpError");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeExtFromMime(mimeType) {
  const m = String(mimeType || "").toLowerCase();
  if (m === "application/pdf") return ".pdf";
  if (m === "application/msword") return ".doc";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return ".docx";
  return "";
}

function storeBufferToUploads({ folder, buffer, mimeType }) {
  if (!buffer || !Buffer.isBuffer(buffer)) throw new HttpError(400, "Invalid upload");
  const uploadsRoot = path.join(__dirname, "..", "uploads");
  const targetDir = path.join(uploadsRoot, folder);
  ensureDir(targetDir);
  const ext = safeExtFromMime(mimeType);
  const name = `${Date.now()}_${crypto.randomBytes(8).toString("hex")}${ext}`;
  const absPath = path.join(targetDir, name);
  fs.writeFileSync(absPath, buffer);
  return { storedName: name, absPath, relPath: path.join(folder, name) };
}

function resolveUploadsPath({ folder, storedName }) {
  const uploadsRoot = path.join(__dirname, "..", "uploads");
  const abs = path.join(uploadsRoot, folder, storedName);
  // Prevent path traversal.
  const normalized = path.normalize(abs);
  if (!normalized.startsWith(path.normalize(path.join(uploadsRoot, folder) + path.sep))) {
    throw new HttpError(400, "Invalid file path");
  }
  return normalized;
}

module.exports = { storeBufferToUploads, resolveUploadsPath };

