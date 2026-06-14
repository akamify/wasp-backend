const crypto = require("crypto");
const { uploadBufferToCloudinary } = require("@shared/services/cloudinaryService");

async function uploadMediaObject({ workspaceId, buffer, mimeType, originalName, extension }) {
  const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
  const folder = `waspakamify/media/${workspaceId}`;
  const result = await uploadBufferToCloudinary({
    buffer,
    mimeType,
    originalName,
    folder,
  });
  return {
    checksum,
    storageKey: String(result.public_id || result.asset_id || checksum),
    publicUrl: String(result.secure_url || result.url || ""),
    extension,
  };
}

module.exports = { uploadMediaObject };
