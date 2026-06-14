const path = require("path");
const net = require("net");
const { HttpError } = require("@shared/utils/httpError");
const { META_MEDIA_LIMITS } = require("@shared/constants/metaMediaLimits");

function extensionOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function mediaLimit(mediaType) {
  const type = String(mediaType || "").toLowerCase();
  const limit = META_MEDIA_LIMITS[type];
  if (!limit) {
    throw new HttpError(400, "Unsupported media type", {
      code: "MEDIA_TYPE_NOT_SUPPORTED",
    });
  }
  return { type, limit };
}

function validateMediaFile({ mediaType, mimeType, originalName, sizeBytes }) {
  const { type, limit } = mediaLimit(mediaType);
  const size = Number(sizeBytes || 0);
  if (!size || size < 1) {
    throw new HttpError(400, "Media file is empty", { code: "MEDIA_FILE_EMPTY" });
  }
  if (size > limit.maxBytes) {
    throw new HttpError(400, "Media file is too large", {
      code: "MEDIA_FILE_TOO_LARGE",
      maxBytes: limit.maxBytes,
    });
  }
  const mime = String(mimeType || "").toLowerCase();
  if (!limit.allowedMimeTypes.includes(mime)) {
    throw new HttpError(400, "Media MIME type is not supported", {
      code: "MEDIA_TYPE_NOT_SUPPORTED",
    });
  }
  const extension = extensionOf(originalName);
  if (!limit.allowedExtensions.includes(extension)) {
    throw new HttpError(400, "Media extension is not supported", {
      code: "MEDIA_EXTENSION_NOT_SUPPORTED",
    });
  }
  return { mediaType: type, extension };
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIp(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return false;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

function validatePublicMediaUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new HttpError(400, "Media URL is invalid", { code: "MEDIA_URL_INVALID" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "Media URL must use http or https", {
      code: "MEDIA_URL_INVALID",
    });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "0.0.0.0" ||
    isPrivateIp(hostname)
  ) {
    throw new HttpError(400, "Private or local media URLs are blocked", {
      code: "MEDIA_URL_BLOCKED",
    });
  }
  return parsed.toString();
}

function maskedUrlLog(value) {
  try {
    const parsed = new URL(String(value || ""));
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

module.exports = {
  extensionOf,
  maskedUrlLog,
  mediaLimit,
  validateMediaFile,
  validatePublicMediaUrl,
};
