const cloudinary = require("cloudinary").v2;

function isCloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function ensureConfigured() {
  if (!isCloudinaryConfigured()) return false;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return true;
}

function uploadBufferToCloudinary({ buffer, mimeType, originalName, folder }) {
  if (!ensureConfigured()) {
    const err = new Error("Cloudinary is not configured");
    err.code = "CLOUDINARY_NOT_CONFIGURED";
    throw err;
  }

  const targetFolder = String(folder || process.env.CLOUDINARY_FOLDER || "waspakamify").trim();
  const safeOriginal = String(originalName || "resume").trim() || "resume";
  const resourceType = "raw";

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: targetFolder,
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        filename_override: safeOriginal,
        context: { original_mime: String(mimeType || "") },
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { isCloudinaryConfigured, uploadBufferToCloudinary };

