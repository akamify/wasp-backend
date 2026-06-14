// Keep aligned with Meta WhatsApp Cloud API supported media type limits.
const META_MEDIA_LIMITS = Object.freeze({
  image: Object.freeze({
    maxBytes: 5 * 1024 * 1024,
    allowedMimeTypes: Object.freeze(["image/jpeg", "image/png"]),
    allowedExtensions: Object.freeze([".jpg", ".jpeg", ".png"]),
  }),
  video: Object.freeze({
    maxBytes: 16 * 1024 * 1024,
    allowedMimeTypes: Object.freeze(["video/mp4"]),
    allowedExtensions: Object.freeze([".mp4"]),
  }),
  audio: Object.freeze({
    maxBytes: 16 * 1024 * 1024,
    allowedMimeTypes: Object.freeze([
      "audio/aac",
      "audio/mp4",
      "audio/mpeg",
      "audio/amr",
      "audio/ogg",
    ]),
    allowedExtensions: Object.freeze([".aac", ".m4a", ".mp3", ".amr", ".ogg"]),
  }),
  document: Object.freeze({
    maxBytes: 100 * 1024 * 1024,
    allowedMimeTypes: Object.freeze([
      "text/plain",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]),
    allowedExtensions: Object.freeze([
      ".txt",
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
    ]),
  }),
});

module.exports = { META_MEDIA_LIMITS };
