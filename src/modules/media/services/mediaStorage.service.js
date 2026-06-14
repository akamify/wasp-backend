const crypto = require("crypto");
const path = require("path");
const { uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");

async function uploadMediaObject({ workspaceId, buffer, mimeType, originalName, extension }) {
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const folder = `waspakamify/media/${workspaceId}`;
  const safeOriginalName =
    path
      .basename(String(originalName || `media${extension || ""}`))
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 180) || `media${extension || ""}`;
  const result = await uploadBufferToCloudinary({
    buffer,
    mimeType,
    originalName: safeOriginalName,
    folder,
  });
  return {
    checksum,
    storageProvider: "cloudinary",
    storageKey: String(result.public_id || result.asset_id || checksum),
    publicUrl: String(result.secure_url || result.url || ""),
    extension,
  };
}

module.exports = { uploadMediaObject };
