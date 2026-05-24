const crypto = require("crypto");

function hashForLookup(value) {
  const secret =
    process.env.CREDENTIALS_LOOKUP_SECRET || process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Missing CREDENTIALS_LOOKUP_SECRET (or CREDENTIALS_ENCRYPTION_KEY) in environment"
    );
  }

  return crypto
    .createHmac("sha256", secret)
    .update(String(value))
    .digest("hex");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = { hashForLookup, sha256Hex };

