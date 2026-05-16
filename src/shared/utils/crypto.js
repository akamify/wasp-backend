const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // recommended for GCM
const TAG_BYTES = 16;

function getKey() {
  const keyB64 = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!keyB64) {
    throw new Error(
      "Missing CREDENTIALS_ENCRYPTION_KEY (base64-encoded 32 bytes) in environment"
    );
  }

  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    throw new Error(
      "Invalid CREDENTIALS_ENCRYPTION_KEY: expected 32 bytes after base64 decoding"
    );
  }
  return key;
}

function encryptString(plainText) {
  if (plainText == null) return "";

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: iv.tag.ciphertext (all base64)
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

function decryptString(payload) {
  if (!payload) return "";

  const [ivB64, tagB64, dataB64] = String(payload).split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted payload format");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid auth tag length");

  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString("utf8");
}

module.exports = { encryptString, decryptString };

