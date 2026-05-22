const crypto = require("crypto");

function hashIdempotencyParts(parts) {
  const raw = Array.isArray(parts) ? parts.map((p) => String(p || "")).join("|") : String(parts || "");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

module.exports = { hashIdempotencyParts };

