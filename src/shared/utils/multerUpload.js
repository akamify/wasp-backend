const multer = require("multer");
const { HttpError } = require("@shared/utils/httpError");

function buildMemoryUpload({ maxFileSizeBytes, allowedMimeTypes }) {
  const allowed = Array.isArray(allowedMimeTypes) ? allowedMimeTypes.filter(Boolean) : [];
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes },
    fileFilter(req, file, cb) {
      if (allowed.length > 0 && !allowed.includes(String(file?.mimetype || ""))) {
        return cb(new HttpError(400, "Unsupported file type"));
      }
      return cb(null, true);
    },
  });
}

module.exports = { buildMemoryUpload };

