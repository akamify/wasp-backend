const path = require("path");
const net = require("net");
const { HttpError } = require("@shared/utils/httpError");
const { META_MEDIA_LIMITS } = require("@shared/constants/metaMediaLimits");

function extensionOf(name) {
  return path.extname(String(name || "")).toLowerCase();
}

function detectMediaMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (buffer.subarray(0, 2).toString("ascii") === "MZ") {
    return "application/x-msdownload";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (buffer.subarray(0, 3).toString("ascii") === "ID3") {
    return "audio/mpeg";
  }
  if (buffer.subarray(0, 5).toString("ascii") === "#!AMR") {
    return "audio/amr";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    return brand.startsWith("3g") ? "video/3gpp" : "video/mp4";
  }
  return "";
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

function validateMediaFile({
  mediaType,
  mimeType,
  originalName,
  sizeBytes,
  buffer,
}) {
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
  const extension = extensionOf(originalName);
  const detectedMime = detectMediaMime(buffer);
  if (detectedMime === "application/x-msdownload") {
    throw new HttpError(400, "Executable files are not allowed", {
      code: "MEDIA_TYPE_NOT_SUPPORTED",
    });
  }
  const m4aContainerMatch =
    extension === ".m4a" &&
    mime === "audio/mp4" &&
    detectedMime === "video/mp4";
  if (detectedMime && detectedMime !== mime && !m4aContainerMatch) {
    throw new HttpError(400, "File content does not match its MIME type", {
      code: "MEDIA_TYPE_NOT_SUPPORTED",
    });
  }
  if (!limit.allowedMimeTypes.includes(mime)) {
    throw new HttpError(400, "Media MIME type is not supported", {
      code: "MEDIA_TYPE_NOT_SUPPORTED",
    });
  }
  const baseName = path.basename(String(originalName || "")).toLowerCase();
  if (
    /\.(exe|com|bat|cmd|ps1|sh|js|mjs|cjs|php|jar|msi|scr)(\.|$)/i.test(
      baseName
    )
  ) {
    throw new HttpError(400, "Executable or script files are not allowed", {
      code: "MEDIA_EXTENSION_NOT_SUPPORTED",
    });
  }
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
  detectMediaMime,
  maskedUrlLog,
  mediaLimit,
  validateMediaFile,
  validatePublicMediaUrl,
};
